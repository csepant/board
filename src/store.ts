// Append-only JSONL persistence, one file per room under ~/.board/rooms/.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, Vote } from "./protocol";

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

function votesFile(room: string): string {
  return join(roomsDir, `${room}.votes.json`);
}

export function loadVotes(room: string): Vote[] {
  const file = votesFile(room);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function saveVotes(room: string, votes: Vote[]) {
  ensureDirs();
  writeFileSync(votesFile(room), JSON.stringify(votes, null, 2));
}

const projectsFile = () => join(dataDir, "projects.json");

/** room name -> absolute project directory */
export function loadProjects(): Record<string, string> {
  if (!existsSync(projectsFile())) return {};
  try {
    return JSON.parse(readFileSync(projectsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function saveProjects(projects: Record<string, string>) {
  ensureDirs();
  writeFileSync(projectsFile(), JSON.stringify(projects, null, 2));
}

export function listRoomsOnDisk(): string[] {
  if (!existsSync(roomsDir)) return [];
  return readdirSync(roomsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}
