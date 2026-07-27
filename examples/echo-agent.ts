// The smallest possible agent: joins a room, replies when @mentioned.
//
//   bun examples/echo-agent.ts <room> [--name echo] [--port 7077]

import { BoardClient } from "../src/client";

const args = process.argv.slice(2);
const room = args.find((a) => !a.startsWith("--")) ?? "lobby";
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const name = flag("name") ?? "echo";

const client = new BoardClient({
  room,
  name,
  kind: "agent",
  port: flag("port") ? Number(flag("port")) : undefined,
  onWelcome: (w) => console.log(`joined #${w.room} as ${w.you}`),
  onStatus: (s) => console.log(s),
  onMessage: (msg) => {
    if (msg.from === name) return;
    if (msg.text.toLowerCase().includes(`@${name.toLowerCase()}`)) {
      client.send(`echo: ${msg.text.replace(new RegExp(`@${name}`, "gi"), "").trim()}`);
    }
  },
});

client.connect();
