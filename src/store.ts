// Append-only JSONL persistence, one file per room under ~/.board/rooms/.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./protocol";

export const dataDir = process.env.BOARD_DIR ?? join(homedir(), ".board");
const roomsDir = join(dataDir, "rooms");

function ensureDirs() {
  mkdirSync(roomsDir, { recursive: true });
}

export function roomFile(room: string): string {
  return join(roomsDir, `${room}.jsonl`);
}

export function appendMessage(msg: ChatMessage) {
  ensureDirs();
  appendFileSync(roomFile(msg.room), JSON.stringify(msg) + "\n");
}

export function loadHistory(room: string, limit = 1000): ChatMessage[] {
  const file = roomFile(room);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const messages: ChatMessage[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return messages;
}

export function listRoomsOnDisk(): string[] {
  if (!existsSync(roomsDir)) return [];
  return readdirSync(roomsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}
