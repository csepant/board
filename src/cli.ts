#!/usr/bin/env bun
// board — a local room where humans and agents collaborate.
//
//   board join <room>            live chat TUI
//   board invite <room> --name x print onboarding instructions for any agent
//   board send <room> <text...>  post a one-off message
//   board tail <room>            stream messages to stdout (JSONL with --json)
//   board rooms                  list rooms
//   board serve                  run the server in the foreground

import { mkdirSync, openSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_PORT, sanitizeName, sanitizeRoom } from "./protocol";
import type { ChatMessage } from "./protocol";
import { dataDir } from "./store";

interface Parsed {
  args: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Parsed {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

// Everything after a bare `--` is a command to spawn (for `board pipe`).
const rawArgv = process.argv.slice(2);
const sepIdx = rawArgv.indexOf("--");
const pipeCmd = sepIdx === -1 ? [] : rawArgv.slice(sepIdx + 1);
const { args, flags } = parseArgv(sepIdx === -1 ? rawArgv : rawArgv.slice(0, sepIdx));
const command = args[0];
const port = Number(flags.port ?? DEFAULT_PORT);
const base = `http://localhost:${port}`;
const defaultName = () => sanitizeName(String(flags.name ?? userInfo().username ?? "you"));

async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the server as a detached background process if it isn't running. */
async function ensureServer() {
  if (await serverIsUp()) return;
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, "server.log"), "a");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "server.ts"), "--port", String(port)],
    { stdin: "ignore", stdout: log, stderr: log },
  );
  child.unref();
  for (let i = 0; i < 20; i++) {
    if (await serverIsUp()) {
      console.error(`started board server on ${base} (log: ${join(dataDir, "server.log")})`);
      return;
    }
    await Bun.sleep(150);
  }
  console.error(`could not start board server on port ${port} — is something else on it?`);
  process.exit(1);
}

/** Room for project-centric commands: --room flag, else the cwd's name. */
const cwdRoom = () => sanitizeRoom(String(flags.room ?? basename(process.cwd())));

async function bindProject(room: string): Promise<void> {
  const res = await fetch(`${base}/rooms/${room}/project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: process.cwd() }),
  });
  if (!res.ok) console.error(`warning: could not bind project: ${await res.text()}`);
}

async function roomCursor(room: string): Promise<number> {
  const res = await fetch(`${base}/rooms/${room}/messages?since=0&limit=1`);
  const body = (await res.json()) as { cursor: number };
  return body.cursor ?? 0;
}

function printHelp() {
  console.log(`board — a local room where humans and agents collaborate

usage:
  board                                 project mode: bind the cwd to a room named
                                        after it, open the TUI (same as: board up)
  board spawn <harness> <name> [role…]  spawn an agent into the cwd's room, working
                                        in its own git worktree (branch board/<name>)
  board agents [--room r]               list spawned agents and their status
  board kill <name> [--room r]          stop a spawned agent
  board diff <name> [--room r]          print an agent's branch diff (pipe to less)
  board merge <name> [--room r]         merge an agent's branch into your tree

  board join <room> [--name you]        join a room in a live chat TUI
  board invite <room> --name <agent>    print instructions to paste into any agent
  board send <room> <text...> [--name]  post a single message (default kind: human)
  board tail <room> [--json] [--since]  follow a room's messages on stdout
  board export <room>                   dump a room's full history as JSONL
  board stdio <room> [--name] [--plain] be the connection: room -> stdout, stdin -> room
  board pipe <room> --name <n> -- <cmd> spawn <cmd>, wire its stdio into the room
                                        (stdout bursts buffered; --line to post per line)
  board votes <room>                    list votes and results
  board rooms                           list rooms and who's in them
  board serve [--port N]                run the server in the foreground

vote from the TUI:  /vote <question> [| opt | opt]   /cast v1 <option>   /close v1   /votes

options:
  --port N     server port (default ${DEFAULT_PORT}, or BOARD_PORT)
  --name NAME  your display name (default: $USER)

data lives in ${dataDir} (override with BOARD_DIR)`);
}

switch (command) {
  case undefined:
  case "up": {
    const room = cwdRoom();
    await ensureServer();
    await bindProject(room);
    const { runTui } = await import("./tui");
    await runTui({ room, name: defaultName(), port });
    break;
  }

  case "spawn": {
    const harness = args[1];
    const name = args[2];
    if (!harness || !name) {
      console.error("usage: board spawn <harness> <name> [role text…]  (run inside the project dir)");
      process.exit(1);
    }
    const room = cwdRoom();
    await ensureServer();
    await bindProject(room);
    const res = await fetch(`${base}/rooms/${room}/agents/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness, role: args.slice(3).join(" ") }),
    });
    const body = (await res.json()) as { error?: string; agent?: { branch: string; workspace: string } };
    if (!res.ok) {
      console.error(`spawn failed: ${body.error}`);
      process.exit(1);
    }
    console.log(`spawned ${name} (${harness}) in #${room} — branch ${body.agent!.branch}`);
    console.log(`worktree: ${body.agent!.workspace}`);
    break;
  }

  case "agents": {
    const room = cwdRoom();
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/agents`);
    const { agents } = (await res.json()) as {
      agents: { name: string; harness: string; status: string; branch: string; role: string }[];
    };
    if (agents.length === 0) {
      console.log(`no agents in #${room} — spawn one with: board spawn claude alice`);
      break;
    }
    for (const a of agents) {
      console.log(`${a.name}  ${a.harness}  [${a.status}]  ${a.branch}${a.role ? `  · ${a.role}` : ""}`);
    }
    break;
  }

  case "kill": {
    const name = args[1];
    if (!name) {
      console.error("usage: board kill <name> [--room r]");
      process.exit(1);
    }
    const room = cwdRoom();
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/agents/${name}`, { method: "DELETE" });
    if (!res.ok) {
      console.error(`kill failed: ${((await res.json()) as { error?: string }).error}`);
      process.exit(1);
    }
    console.log(`stopped ${name}`);
    break;
  }

  case "diff": {
    const name = args[1];
    if (!name) {
      console.error("usage: board diff <name> [--room r]");
      process.exit(1);
    }
    const room = cwdRoom();
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/agents/${name}/diff`);
    const body = (await res.json()) as { error?: string; stat?: string; diff?: string; dirty?: string };
    if (!res.ok) {
      console.error(`diff failed: ${body.error}`);
      process.exit(1);
    }
    if (body.dirty) console.error(`# uncommitted in worktree:\n${body.dirty}\n`);
    console.log(body.diff || "(no committed changes vs your tree)");
    break;
  }

  case "merge": {
    const name = args[1];
    if (!name) {
      console.error("usage: board merge <name> [--room r]");
      process.exit(1);
    }
    const room = cwdRoom();
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/agents/${name}/merge`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; output: string };
    console.log(body.output);
    process.exit(body.ok ? 0 : 1);
  }

  case "serve": {
    const { startServer } = await import("./server");
    const srv = startServer(port);
    console.log(`board server listening on http://localhost:${srv.port}`);
    console.log(`join a room:   bun src/cli.ts join lobby`);
    break;
  }

  case "join": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    await ensureServer();
    const { runTui } = await import("./tui");
    await runTui({ room, name: defaultName(), port });
    break;
  }

  case "send": {
    const room = sanitizeRoom(args[1] ?? "");
    const text = args.slice(2).join(" ");
    if (!args[1] || !text) {
      console.error("usage: board send <room> <text...> [--name you] [--kind agent]");
      process.exit(1);
    }
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: defaultName(),
        kind: flags.kind === "agent" ? "agent" : "human",
        text,
      }),
    });
    if (!res.ok) {
      console.error(`send failed: ${await res.text()}`);
      process.exit(1);
    }
    break;
  }

  case "tail": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    await ensureServer();
    let cursor = flags.since !== undefined ? Number(flags.since) : await roomCursor(room);
    if (flags.all) cursor = 0;
    console.error(`tailing #${room} from seq ${cursor} — ctrl+c to stop`);
    while (true) {
      try {
        const res = await fetch(`${base}/rooms/${room}/messages?since=${cursor}&wait=30`);
        const body = (await res.json()) as { messages: ChatMessage[]; cursor: number };
        for (const msg of body.messages) {
          if (flags.json) {
            console.log(JSON.stringify(msg));
          } else {
            const time = new Date(msg.ts).toTimeString().slice(0, 5);
            console.log(`${time} ${msg.from}${msg.kind === "agent" ? "*" : ""}: ${msg.text}`);
          }
        }
        cursor = body.cursor;
      } catch {
        await Bun.sleep(1000);
      }
    }
    break;
  }

  case "stdio": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    await ensureServer();
    const { runStdio } = await import("./stdio");
    runStdio({ room, name: defaultName(), port, plain: Boolean(flags.plain) });
    break;
  }

  case "pipe": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    if (pipeCmd.length === 0) {
      console.error("usage: board pipe <room> --name <bot> [--plain] [--line] -- <command...>");
      process.exit(1);
    }
    await ensureServer();
    const { runPipe } = await import("./stdio");
    runPipe({
      room,
      name: defaultName(),
      port,
      cmd: pipeCmd,
      plain: Boolean(flags.plain),
      line: Boolean(flags.line),
      flushMs: flags["flush-ms"] ? Number(flags["flush-ms"]) : undefined,
    });
    break;
  }

  case "votes": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    await ensureServer();
    const res = await fetch(`${base}/rooms/${room}/votes`);
    const { votes } = (await res.json()) as {
      votes: { id: string; status: string; question: string; options: string[]; ballots: Record<string, string>; result?: { winner: string | null } }[];
    };
    if (votes.length === 0) {
      console.log("no votes yet");
      break;
    }
    for (const v of votes) {
      const tally = v.options
        .map((o) => `${o} ${Object.values(v.ballots).filter((b) => b === o).length}`)
        .join(" · ");
      console.log(`${v.id} [${v.status}] "${v.question}" (${tally})${v.result?.winner ? ` → ${v.result.winner}` : ""}`);
    }
    break;
  }

  case "export": {
    const room = sanitizeRoom(args[1] ?? "");
    if (!args[1]) {
      console.error("usage: board export <room>   (prints the room's full history as JSONL)");
      process.exit(1);
    }
    const { loadHistory } = await import("./store");
    for (const msg of loadHistory(room, Number.MAX_SAFE_INTEGER)) {
      console.log(JSON.stringify(msg));
    }
    break;
  }

  case "rooms": {
    await ensureServer();
    const res = await fetch(`${base}/rooms`);
    const body = (await res.json()) as {
      rooms: { name: string; participants: { name: string; kind: string }[]; cursor: number }[];
    };
    if (body.rooms.length === 0) {
      console.log("no rooms yet — create one with: board join <room>");
      break;
    }
    for (const room of body.rooms) {
      const who = room.participants
        .map((p) => `${p.name}${p.kind === "agent" ? "*" : ""}`)
        .join(", ");
      console.log(`#${room.name}  (${room.cursor} messages)  ${who ? "· " + who : "· empty"}`);
    }
    break;
  }

  case "invite": {
    const room = sanitizeRoom(args[1] ?? "lobby");
    if (!flags.name) {
      console.error("usage: board invite <room> --name <agent-name>");
      process.exit(1);
    }
    await ensureServer();
    const name = sanitizeName(String(flags.name));
    const cursor = await roomCursor(room);
    console.log(`─── paste everything below this line into your agent ───────────────

You are joining "#${room}" — a local collaboration room where humans and other
agents talk and work together. Your handle is "${name}". The room server runs
at ${base} and speaks plain JSON over HTTP.

First, announce yourself (write your own one-line intro):

  curl -s -X POST ${base}/rooms/${room}/messages \\
    -H 'content-type: application/json' \\
    -d '{"from":"${name}","kind":"agent","text":"${name} here — ready to help."}'

Then repeat this loop for the rest of the session:

1. Fetch new messages (long-polls up to 25s; your cursor starts at ${cursor}):

     curl -s '${base}/rooms/${room}/messages?since=${cursor}&wait=25'

   The response is {"messages":[...],"cursor":N}. Always pass the returned
   cursor as ?since= on your next fetch.

2. Read the new messages. Ignore your own (from == "${name}").

3. Reply with the same POST as above when: a message mentions @${name}, a
   question is addressed to you, or you have something genuinely useful to
   add. Otherwise post nothing and keep polling. Never reply to yourself,
   and don't answer other agents unless they mention you — that causes loops.

4. Go back to step 1. Keep looping until a human tells you to leave the room.

Keep replies short and conversational — it's a chat room, not a report.`);
    break;
  }

  case "help":
    printHelp();
    break;

  default:
    console.error(`unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
