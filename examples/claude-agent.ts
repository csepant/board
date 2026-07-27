// A Claude-powered room participant using the `claude` CLI headlessly.
//
//   bun examples/claude-agent.ts <room> --name reviewer \
//     --persona "You are a pragmatic senior code reviewer." [--eager] [--port 7077]
//
// By default it replies only when @mentioned (safe with multiple agents in a
// room). With --eager it also considers replying to every human message.

import { BoardClient } from "../src/client";
import type { ChatMessage } from "../src/protocol";

const args = process.argv.slice(2);
const room = args.find((a) => !a.startsWith("--")) ?? "lobby";
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i !== -1 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined;
};
const has = (k: string) => args.includes(`--${k}`);

const name = flag("name") ?? "claude";
const persona = flag("persona") ?? "You are a helpful, concise collaborator.";
const eager = has("eager");

const transcript: ChatMessage[] = [];
let busy = false;
let pendingCheck = false;

function shouldRespond(msg: ChatMessage): boolean {
  if (msg.from === name) return false;
  if (msg.text.toLowerCase().includes(`@${name.toLowerCase()}`)) return true;
  return eager && msg.kind === "human";
}

async function respond() {
  if (busy) {
    pendingCheck = true;
    return;
  }
  busy = true;
  try {
    const recent = transcript.slice(-30);
    const lines = recent
      .map((m) => `${m.from}${m.kind === "agent" ? " (agent)" : ""}: ${m.text}`)
      .join("\n");

    const prompt = `You are "${name}", a participant in a terminal chat room called "#${room}" \
where humans and agents collaborate.

Persona: ${persona}

Recent conversation (oldest first):
${lines}

Write your next chat message as ${name}. Rules:
- Output ONLY the message text, no quotes, no name prefix.
- Keep it short and conversational — it's a chat room, not a report.
- If you have nothing genuinely useful to add, output exactly: PASS`;

    const proc = Bun.spawn(["claude", "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reply = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) {
      console.error("claude failed:", (await new Response(proc.stderr).text()).trim());
      return;
    }
    if (reply && reply !== "PASS") client.send(reply);
  } finally {
    busy = false;
    if (pendingCheck) {
      pendingCheck = false;
      const last = transcript.at(-1);
      if (last && shouldRespond(last)) void respond();
    }
  }
}

const client = new BoardClient({
  room,
  name,
  kind: "agent",
  port: flag("port") ? Number(flag("port")) : undefined,
  onWelcome: (w) => {
    transcript.push(...w.history);
    console.log(`joined #${w.room} as ${w.you} (${eager ? "eager" : "mention-only"})`);
  },
  onStatus: (s) => console.log(s),
  onMessage: (msg) => {
    transcript.push(msg);
    if (transcript.length > 100) transcript.splice(0, transcript.length - 60);
    if (shouldRespond(msg)) void respond();
  },
});

client.connect();
