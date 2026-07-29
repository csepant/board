// One spawned agent: joins the room over WebSocket, and on each message that
// mentions it runs a full headless harness turn (claude -p / kimi -p / ...)
// inside its own git worktree, then posts the reply back to the room.
//
// Spawned by the server:
//   bun src/agent-runner.ts --room X --name alice --harness claude \
//     --workspace <worktree> --branch board/alice --port 7077 [--role "..."]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "./client";
import { buildArgv, loadHarnesses, parseOutput } from "./harness";
import type { ChatMessage } from "./protocol";
import { dataDir } from "./store";

const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REPLY_LENGTH = 4000;
/** If this many consecutive messages are agent-to-agent, wait for a human. */
const AGENT_CHATTER_LIMIT = 8;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const room = flag("room")!;
const name = flag("name")!;
const harnessName = flag("harness")!;
const workspace = flag("workspace")!;
const branch = flag("branch") ?? `board/${name}`;
const port = Number(flag("port"));
const role = flag("role") ?? "";

const harness = loadHarnesses()[harnessName];
if (!harness || !room || !name || !workspace || !port) {
  console.error("agent-runner: missing/invalid arguments");
  process.exit(1);
}

// Session id survives runner restarts (claude --resume; text harnesses ignore it).
const sessionFile = join(dataDir, "agents", `${room}--${name}.session`);
let session: string | null = existsSync(sessionFile)
  ? readFileSync(sessionFile, "utf8").trim() || null
  : null;

const transcript: ChatMessage[] = [];
let lastHandledSeq = 0;
let busy = false;
let queued = false;

const mentioned = (text: string) => {
  const lower = text.toLowerCase();
  return lower.includes(`@${name.toLowerCase()}`) || lower.includes("@all") || lower.includes("@everyone");
};

function shouldRespond(msg: ChatMessage): boolean {
  if (msg.from === name || msg.kind === "system") return false;
  if (!mentioned(msg.text)) return false;
  // Loop guard: if the room has been all-agent chatter for a while, hold off.
  const recent = transcript.slice(-AGENT_CHATTER_LIMIT);
  if (recent.length === AGENT_CHATTER_LIMIT && recent.every((m) => m.kind !== "human")) {
    console.error("loop guard: only agents talking — waiting for a human message");
    return false;
  }
  return true;
}

function buildPrompt(): string {
  const pending = transcript.filter((m) => m.seq > lastHandledSeq && m.kind !== "system");
  const context = transcript
    .filter((m) => m.seq <= lastHandledSeq && m.kind !== "system")
    .slice(-15)
    .map((m) => `${m.from}: ${m.text}`)
    .join("\n");
  const fresh = pending.map((m) => `${m.from}: ${m.text}`).join("\n");
  lastHandledSeq = transcript.at(-1)?.seq ?? lastHandledSeq;

  return `You are "${name}", an autonomous agent collaborating with humans and other agents in the chat room #${room}.
${role ? `Your role: ${role}\n` : ""}\
Your working directory is your own isolated git worktree on branch ${branch} of the shared project. \
Teammates work on their own branches; a human reviews and merges via the room.

Ground rules:
- Do real work here with your tools. git-commit completed work with clear messages so it can be reviewed and merged.
- Keep chat replies short and conversational. Address teammates as @theirname. Never prefix your reply with your own name.
- If asked for status, be concrete: files touched, commits made.
${context ? `\nEarlier conversation:\n${context}\n` : ""}
New messages addressed to you:
${fresh}

Do whatever work is being asked of you now, then output ONLY your chat reply (no markdown headers, no name prefix).`;
}

async function runTurn() {
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  try {
    const argv = buildArgv(harness, buildPrompt(), session);
    console.error(`turn: ${argv[0]} (session=${session ?? "new"})`);
    const proc = Bun.spawn(argv, { cwd: workspace, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), TURN_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).slice(-500);
      console.error(`harness exited ${exitCode}: ${stderr}`);
      client.send(`(⚠ my ${harnessName} turn failed — exit ${exitCode}. check my log for details)`);
      return;
    }

    const [reply, newSession] = parseOutput(harness, stdout);
    if (newSession && newSession !== session) {
      session = newSession;
      mkdirSync(join(dataDir, "agents"), { recursive: true });
      writeFileSync(sessionFile, session);
    }
    if (reply) client.send(reply.slice(0, MAX_REPLY_LENGTH));
  } catch (e) {
    console.error(`turn error: ${e}`);
  } finally {
    busy = false;
    if (queued) {
      queued = false;
      // New mentions arrived mid-turn; they are > lastHandledSeq, so run again.
      const unhandled = transcript.filter((m) => m.seq > lastHandledSeq);
      if (unhandled.some(shouldRespond)) void runTurn();
    }
  }
}

const client = new BoardClient({
  room,
  name,
  kind: "agent",
  port,
  onWelcome: (w) => {
    for (const m of w.history) transcript.push(m);
    lastHandledSeq = transcript.at(-1)?.seq ?? 0; // don't replay old history as work
    console.error(`joined #${w.room} as ${w.you} (${harnessName}, ${workspace})`);
    client.send(`ready — I'm ${name} (${harnessName}), working on branch ${branch}. Mention @${name} to hand me work.`);
  },
  onStatus: (s) => console.error(s),
  onMessage: (msg) => {
    transcript.push(msg);
    if (transcript.length > 200) transcript.splice(0, transcript.length - 100);
    if (shouldRespond(msg)) void runTurn();
  },
});

client.connect();
