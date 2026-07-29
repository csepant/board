// stdio transports: connect a room to a process's stdin/stdout.
//
// `board stdio <room>` — this process IS the connection: room messages stream
// out on stdout (JSONL, or "from: text" with --plain); lines written to stdin
// are posted to the room. Spawn it from any harness and talk over pipes.
// Status/errors go to stderr so stdout stays pure data.
//
// `board pipe <room> -- <cmd...>` — the inverse: spawns <cmd>, feeds room
// messages to its stdin, and posts its stdout back to the room. Output is
// buffered: a burst of lines is flushed as ONE message after a quiet gap
// (or when the buffer gets large), so chatty processes don't spam the room.
// Use --line to post each stdout line individually instead.

import { BoardClient } from "./client";
import type { ChatMessage } from "./protocol";

export interface BridgeOptions {
  room: string;
  name: string;
  port?: number;
  plain?: boolean;
}

/** stdin line -> message text; accepts plain text or {"text": "..."} JSON. */
function parseInboundLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.text === "string") return obj.text;
    } catch {
      // fall through: treat as plain text
    }
  }
  return trimmed;
}

export function runStdio(opts: BridgeOptions) {
  let you = opts.name;
  const client = new BoardClient({
    room: opts.room,
    name: opts.name,
    kind: "agent",
    port: opts.port,
    onWelcome: (w) => {
      you = w.you;
      console.error(`joined #${w.room} as ${w.you} — stdout: messages, stdin: send`);
    },
    onStatus: (s) => console.error(s),
    onMessage: (msg) => {
      if (msg.from === you) return; // never echo yourself back
      process.stdout.write(
        opts.plain ? `${msg.from}: ${msg.text}\n` : JSON.stringify(msg) + "\n",
      );
    },
  });
  client.connect();

  // NOTE: node:readline on piped stdin stalls Bun's event loop when data is
  // already buffered at startup — use Bun's native stdin stream instead.
  (async () => {
    const decoder = new TextDecoder();
    let pendingLine = "";
    const post = (line: string) => {
      const text = parseInboundLine(line);
      if (text && !client.send(text)) console.error("outbox full — line dropped");
    };
    for await (const chunk of Bun.stdin.stream()) {
      pendingLine += decoder.decode(chunk, { stream: true });
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) post(line);
    }
    if (pendingLine) post(pendingLine);
    // stdin closed: give queued messages a chance to flush before exiting.
    for (let waited = 0; client.pending > 0 && waited < 5000; waited += 50) {
      await Bun.sleep(50);
    }
    client.close();
    process.exit(0);
  })();
}

export interface PipeOptions extends BridgeOptions {
  cmd: string[];
  /** Post each stdout line as its own message instead of buffering bursts. */
  line?: boolean;
  /** Quiet gap (ms) that ends a burst in buffered mode. */
  flushMs?: number;
}

const MAX_BUFFER = 8_000;

export function runPipe(opts: PipeOptions) {
  const child = Bun.spawn(opts.cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let you = opts.name;

  const client = new BoardClient({
    room: opts.room,
    name: opts.name,
    kind: "agent",
    port: opts.port,
    onWelcome: (w) => {
      you = w.you;
      console.error(`joined #${w.room} as ${w.you} — piping ${opts.cmd.join(" ")}`);
    },
    onStatus: (s) => console.error(s),
    onMessage: (msg: ChatMessage) => {
      if (msg.from === you) return;
      child.stdin.write(
        (opts.plain ? `${msg.from}: ${msg.text}` : JSON.stringify(msg)) + "\n",
      );
      child.stdin.flush();
    },
  });
  client.connect();

  // Buffer the child's stdout: flush one message per quiet gap.
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const text = buffer.trim();
    buffer = "";
    if (text && !client.send(text)) console.error("not connected — output dropped");
  };

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      if (opts.line) {
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) client.send(line.trim());
      } else if (buffer.length >= MAX_BUFFER) {
        flush();
      } else {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, opts.flushMs ?? 400);
      }
    }
    flush();
    const code = await child.exited;
    console.error(`process exited (${code})`);
    client.close();
    process.exit(code);
  })();
}
