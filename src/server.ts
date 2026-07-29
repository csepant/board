// The room server: WebSocket + HTTP on one port.
//
//   bun src/server.ts [--port 7077]
//
// Rooms are created on first use. Messages are broadcast to WebSocket
// subscribers and also available over HTTP long-polling, so an agent can
// participate with nothing but curl.

import type { Server, ServerWebSocket } from "bun";
import type {
  ChatMessage,
  ClientFrame,
  Kind,
  Participant,
  Vote,
  VoteEvent,
  WelcomeFrame,
} from "./protocol";
import { DEFAULT_PORT, MAX_TEXT_LENGTH, sanitizeName, sanitizeRoom } from "./protocol";
import {
  appendMessage,
  dataDir,
  listRoomsOnDisk,
  loadHistory,
  loadProjects,
  loadVotes,
  saveProjects,
  saveVotes,
} from "./store";
import { loadHarnesses } from "./harness";
import { diffWorktree, ensureWorktree, mergeAgentBranch } from "./worktree";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

interface WSData {
  room?: string;
  name?: string;
  kind?: Kind;
}

interface AgentProc {
  name: string;
  harness: string;
  role: string;
  workspace: string;
  branch: string;
  proc: ReturnType<typeof Bun.spawn>;
  status: "running" | "exited";
  startedAt: number;
}

interface Room {
  name: string;
  history: ChatMessage[];
  seq: number;
  participants: Map<ServerWebSocket<WSData>, Participant>;
  waiters: Array<() => void>;
  votes: Vote[];
  project?: string;
  agents: Map<string, AgentProc>;
}

const rooms = new Map<string, Room>();
const projects = loadProjects();
let server: Server<WSData>;

const topic = (room: string) => `room:${room}`;

function getRoom(name: string): Room {
  let room = rooms.get(name);
  if (!room) {
    const history = loadHistory(name);
    room = {
      name,
      history,
      seq: history.at(-1)?.seq ?? 0,
      participants: new Map(),
      waiters: [],
      votes: loadVotes(name),
      project: projects[name],
      agents: new Map(),
    };
    rooms.set(name, room);
  }
  return room;
}

function participantList(room: Room): Participant[] {
  return [...room.participants.values()];
}

function postMessage(
  room: Room,
  from: string,
  kind: Kind,
  text: string,
  data?: ChatMessage["data"],
): ChatMessage {
  const msg: ChatMessage = {
    type: "message",
    id: crypto.randomUUID().slice(0, 8),
    seq: ++room.seq,
    room: room.name,
    from,
    kind,
    text: text.slice(0, MAX_TEXT_LENGTH),
    ts: Date.now(),
    ...(data ? { data } : {}),
  };
  room.history.push(msg);
  if (room.history.length > 2000) room.history.splice(0, room.history.length - 1000);
  appendMessage(msg);
  server.publish(topic(room.name), JSON.stringify(msg));
  for (const wake of room.waiters.splice(0)) wake();
  return msg;
}

function broadcastPresence(room: Room, event: "join" | "leave", who: Participant) {
  server.publish(
    topic(room.name),
    JSON.stringify({
      type: "presence",
      event,
      name: who.name,
      kind: who.kind,
      participants: participantList(room),
      ts: Date.now(),
    }),
  );
}

/** Unique name within the room: "sam" -> "sam-2" if taken. */
function dedupeName(room: Room, wanted: string): string {
  const taken = new Set([...room.participants.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// --- votes -----------------------------------------------------------------

function announceVote(room: Room, event: VoteEvent["event"], vote: Vote, text: string) {
  saveVotes(room.name, room.votes);
  postMessage(room, "board", "system", text, { vote: { event, vote } });
}

function tallyText(vote: Vote): string {
  const tally: Record<string, number> = {};
  for (const option of vote.options) tally[option] = 0;
  for (const choice of Object.values(vote.ballots)) tally[choice]++;
  return vote.options.map((o) => `${o} ${tally[o]}`).join(" · ");
}

function openVote(room: Room, from: string, question: string, options: string[]): Vote {
  const clean = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
  const vote: Vote = {
    id: `v${room.votes.length + 1}`,
    room: room.name,
    question: question.trim().slice(0, 500),
    options: clean.length >= 2 ? clean : ["yes", "no"],
    openedBy: from,
    openedAt: Date.now(),
    status: "open",
    ballots: {},
  };
  room.votes.push(vote);
  announceVote(
    room,
    "opened",
    vote,
    `📊 ${from} opened vote ${vote.id}: "${vote.question}" — options: ${vote.options.join(" | ")}. ` +
      `Cast with /cast ${vote.id} <option> (TUI) or POST /rooms/${room.name}/votes/${vote.id}/ballots.`,
  );
  return vote;
}

function castBallot(room: Room, vote: Vote, from: string, option: string): string | null {
  const canonical = vote.options.find((o) => o.toLowerCase() === option.trim().toLowerCase());
  if (!canonical) return `option must be one of: ${vote.options.join(" | ")}`;
  const recast = from in vote.ballots;
  vote.ballots[from] = canonical;
  announceVote(
    room,
    "ballot",
    vote,
    `📊 ${from} ${recast ? "changed their vote to" : "voted"} "${canonical}" on ${vote.id} (${tallyText(vote)})`,
  );
  return null;
}

function closeVote(room: Room, vote: Vote, from: string): Vote {
  const tally: Record<string, number> = {};
  for (const option of vote.options) tally[option] = 0;
  for (const choice of Object.values(vote.ballots)) tally[choice]++;
  const sorted = [...vote.options].sort((a, b) => tally[b] - tally[a]);
  const top = tally[sorted[0]];
  const winner = top > 0 && tally[sorted[1]] < top ? sorted[0] : null;
  vote.status = "closed";
  vote.closedBy = from;
  vote.closedAt = Date.now();
  vote.result = { tally, winner };
  announceVote(
    room,
    "closed",
    vote,
    `📊 vote ${vote.id} closed by ${from}: "${vote.question}" → ` +
      `${winner ? `**${winner}**` : top === 0 ? "no ballots cast" : "tie"} (${tallyText(vote)})`,
  );
  return vote;
}

// --- spawned agents --------------------------------------------------------

const sysMsg = (room: Room, text: string) => postMessage(room, "board", "system", text);

function spawnAgent(room: Room, name: string, harnessName: string, roleText: string): AgentProc {
  if (!room.project) {
    throw new Error(`room #${room.name} is not bound to a project — run \`board\` in the project directory first`);
  }
  const harnesses = loadHarnesses();
  if (!harnesses[harnessName]) {
    throw new Error(`unknown harness "${harnessName}" (have: ${Object.keys(harnesses).join(", ")})`);
  }
  const existing = room.agents.get(name);
  if (existing?.status === "running") throw new Error(`agent "${name}" is already running`);

  const { path: workspace, branch } = ensureWorktree(room.project, room.name, name);

  const logsDir = join(dataDir, "agents");
  mkdirSync(logsDir, { recursive: true });
  const log = openSync(join(logsDir, `${room.name}--${name}.log`), "a");
  const runner = join(import.meta.dir, "agent-runner.ts");
  const args = [
    process.execPath, runner,
    "--room", room.name,
    "--name", name,
    "--harness", harnessName,
    "--workspace", workspace,
    "--branch", branch,
    "--port", String(server.port),
  ];
  if (roleText) args.push("--role", roleText);
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: log, stderr: log });

  const agent: AgentProc = {
    name, harness: harnessName, role: roleText, workspace, branch, proc,
    status: "running", startedAt: Date.now(),
  };
  room.agents.set(name, agent);
  void proc.exited.then((code) => {
    if (agent.status === "running") {
      agent.status = "exited";
      sysMsg(room, `🤖 agent ${name} exited (code ${code}) — respawn with /spawn ${harnessName} ${name}`);
    }
  });
  sysMsg(room, `🤖 spawned ${name} (${harnessName}) on branch ${branch} — mention @${name} to hand it work`);
  return agent;
}

function agentInfo(agent: AgentProc) {
  const { proc, ...rest } = agent;
  return { ...rest, pid: proc.pid };
}

async function messagesSince(room: Room, since: number, waitSec: number, limit: number) {
  let messages = room.history.filter((m) => m.seq > since);
  if (messages.length === 0 && waitSec > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(waitSec, 60) * 1000);
      room.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    messages = room.history.filter((m) => m.seq > since);
  }
  if (limit > 0) messages = messages.slice(-limit);
  return { messages, cursor: room.seq };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

export function startServer(port: number = DEFAULT_PORT): Server<WSData> {
  server = Bun.serve<WSData, never>({
    port,
    idleTimeout: 120,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/ws") {
        if (srv.upgrade(req, { data: {} })) return;
        return json({ error: "websocket upgrade failed" }, 400);
      }

      if (path === "/" || path === "/health") {
        return json({ ok: true, name: "board", rooms: rooms.size });
      }

      if (path === "/rooms" && req.method === "GET") {
        const names = new Set([...listRoomsOnDisk(), ...rooms.keys()]);
        const list = [...names].sort().map((name) => {
          const room = rooms.get(name);
          return {
            name,
            participants: room ? participantList(room) : [],
            cursor: room ? room.seq : loadHistory(name).at(-1)?.seq ?? 0,
            project: room?.project ?? projects[name] ?? null,
            agents: room ? [...room.agents.values()].map((a) => `${a.name}[${a.status}]`) : [],
          };
        });
        return json({ rooms: list });
      }

      const match = path.match(/^\/rooms\/([^/]+)\/messages$/);
      if (match) {
        const room = getRoom(sanitizeRoom(decodeURIComponent(match[1])));

        if (req.method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          const wait = Number(url.searchParams.get("wait") ?? 0) || 0;
          const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
          return json(await messagesSince(room, since, wait, limit));
        }

        if (req.method === "POST") {
          let body: { from?: string; text?: string; kind?: Kind };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON: {from, text, kind?}" }, 400);
          }
          if (!body.from || typeof body.text !== "string" || body.text.length === 0) {
            return json({ error: "required fields: from (string), text (non-empty string)" }, 400);
          }
          const kind: Kind = body.kind === "human" ? "human" : "agent";
          const msg = postMessage(room, sanitizeName(body.from), kind, body.text);
          return json({ ok: true, seq: msg.seq, id: msg.id });
        }
      }

      const projectMatch = path.match(/^\/rooms\/([^/]+)\/project$/);
      if (projectMatch) {
        const room = getRoom(sanitizeRoom(decodeURIComponent(projectMatch[1])));
        if (req.method === "GET") return json({ project: room.project ?? null });
        if (req.method === "POST") {
          let body: { dir?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON: {dir}" }, 400);
          }
          if (!body.dir || !existsSync(body.dir)) return json({ error: `no such directory: ${body.dir}` }, 400);
          if (room.project !== body.dir) {
            room.project = body.dir;
            projects[room.name] = body.dir;
            saveProjects(projects);
            sysMsg(room, `room bound to project ${body.dir}`);
          }
          return json({ ok: true, project: room.project });
        }
      }

      const agentMatch = path.match(/^\/rooms\/([^/]+)\/agents(?:\/([^/]+)(?:\/(diff|merge))?)?$/);
      if (agentMatch) {
        const room = getRoom(sanitizeRoom(decodeURIComponent(agentMatch[1])));
        const [, , agentName, action] = agentMatch;

        if (req.method === "GET" && !agentName) {
          return json({ agents: [...room.agents.values()].map(agentInfo) });
        }

        if (req.method === "GET" && agentName && action === "diff") {
          if (!room.project) return json({ error: "room has no project bound" }, 400);
          try {
            return json({ ...diffWorktree(room.project, room.name, agentName) });
          } catch (e) {
            return json({ error: String(e instanceof Error ? e.message : e) }, 400);
          }
        }

        if (req.method === "POST" && agentName && action === "merge") {
          if (!room.project) return json({ error: "room has no project bound" }, 400);
          const result = mergeAgentBranch(room.project, agentName);
          sysMsg(
            room,
            result.ok
              ? `🔀 merged board/${agentName} into the project tree`
              : `🔀 merge of board/${agentName} FAILED:\n${result.out.slice(0, 500)}`,
          );
          return json({ ok: result.ok, output: result.out }, result.ok ? 200 : 409);
        }

        if (req.method === "POST" && agentName && !action) {
          let body: { harness?: string; role?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON: {harness, role?}" }, 400);
          }
          if (!body.harness) return json({ error: "required field: harness" }, 400);
          try {
            const agent = spawnAgent(room, sanitizeName(agentName), body.harness, body.role ?? "");
            return json({ ok: true, agent: agentInfo(agent) });
          } catch (e) {
            return json({ error: String(e instanceof Error ? e.message : e) }, 400);
          }
        }

        if (req.method === "DELETE" && agentName && !action) {
          const agent = room.agents.get(agentName);
          if (!agent) return json({ error: `no agent "${agentName}"` }, 404);
          if (agent.status === "running") {
            agent.status = "exited";
            agent.proc.kill();
            sysMsg(room, `🤖 ${agentName} stopped`);
          }
          room.agents.delete(agentName);
          return json({ ok: true });
        }
      }

      const voteMatch = path.match(/^\/rooms\/([^/]+)\/votes(?:\/([^/]+)(?:\/(ballots|close))?)?$/);
      if (voteMatch) {
        const room = getRoom(sanitizeRoom(decodeURIComponent(voteMatch[1])));
        const [, , voteId, action] = voteMatch;

        if (req.method === "GET" && !voteId) return json({ votes: room.votes });
        if (req.method === "GET" && voteId && !action) {
          const vote = room.votes.find((v) => v.id === voteId);
          return vote ? json({ vote }) : json({ error: `no vote ${voteId}` }, 404);
        }

        if (req.method === "POST") {
          let body: { from?: string; question?: string; options?: string[]; option?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON" }, 400);
          }
          if (!body.from) return json({ error: "required field: from" }, 400);
          const from = sanitizeName(body.from);

          // POST /rooms/:room/votes — open a vote
          if (!voteId) {
            if (!body.question) return json({ error: "required field: question" }, 400);
            const vote = openVote(room, from, body.question, body.options ?? []);
            return json({ ok: true, vote });
          }

          const vote = room.votes.find((v) => v.id === voteId);
          if (!vote) return json({ error: `no vote ${voteId}` }, 404);

          // POST /rooms/:room/votes/:id/ballots — cast (or change) a ballot
          if (action === "ballots") {
            if (vote.status === "closed") return json({ error: `${voteId} is closed` }, 409);
            if (!body.option) return json({ error: "required field: option" }, 400);
            const err = castBallot(room, vote, from, body.option);
            return err ? json({ error: err }, 400) : json({ ok: true, vote });
          }

          // POST /rooms/:room/votes/:id/close — close and tally
          if (action === "close") {
            if (vote.status === "closed") return json({ error: `${voteId} already closed` }, 409);
            return json({ ok: true, vote: closeVote(room, vote, from) });
          }
        }
      }

      return json({ error: "not found" }, 404);
    },

    websocket: {
      message(ws, raw) {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "frames must be JSON" }));
          return;
        }

        if (!ws.data.room) {
          if (frame.type !== "join" || !frame.room || !frame.name) {
            ws.send(JSON.stringify({ type: "error", message: "first frame must be {type:'join', room, name}" }));
            ws.close();
            return;
          }
          const room = getRoom(sanitizeRoom(frame.room));
          const name = dedupeName(room, sanitizeName(frame.name));
          const kind: Kind = frame.kind === "agent" ? "agent" : "human";
          ws.data = { room: room.name, name, kind };
          room.participants.set(ws, { name, kind });
          ws.subscribe(topic(room.name));

          const since = frame.since ?? 0;
          const welcome: WelcomeFrame = {
            type: "welcome",
            room: room.name,
            you: name,
            participants: participantList(room),
            history: since > 0 ? room.history.filter((m) => m.seq > since) : room.history.slice(-50),
            cursor: room.seq,
          };
          ws.send(JSON.stringify(welcome));
          broadcastPresence(room, "join", { name, kind });
          return;
        }

        if (frame.type === "message" && typeof frame.text === "string" && frame.text.length > 0) {
          const room = getRoom(ws.data.room);
          postMessage(room, ws.data.name!, ws.data.kind!, frame.text);
        }
      },

      close(ws) {
        if (!ws.data.room) return;
        const room = getRoom(ws.data.room);
        const who = room.participants.get(ws);
        room.participants.delete(ws);
        if (who) broadcastPresence(room, "leave", who);
      },
    },
  });

  return server;
}

if (import.meta.main) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : DEFAULT_PORT;
  const srv = startServer(port);
  console.log(`board server listening on http://localhost:${srv.port}`);
}
