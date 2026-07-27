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
import { join } from "node:path";
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

const { args, flags } = parseArgv(process.argv.slice(2));
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

async function roomCursor(room: string): Promise<number> {
  const res = await fetch(`${base}/rooms/${room}/messages?since=0&limit=1`);
  const body = (await res.json()) as { cursor: number };
  return body.cursor ?? 0;
}

function printHelp() {
  console.log(`board — a local room where humans and agents collaborate

usage:
  board join <room> [--name you]        join a room in a live chat TUI
  board invite <room> --name <agent>    print instructions to paste into any agent
  board send <room> <text...> [--name]  post a single message (default kind: human)
  board tail <room> [--json] [--since]  follow a room's messages on stdout
  board rooms                           list rooms and who's in them
  board serve [--port N]                run the server in the foreground

options:
  --port N     server port (default ${DEFAULT_PORT}, or BOARD_PORT)
  --name NAME  your display name (default: $USER)

data lives in ${dataDir} (override with BOARD_DIR)`);
}

switch (command) {
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
  case undefined:
    printHelp();
    break;

  default:
    console.error(`unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}
