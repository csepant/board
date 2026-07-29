// Persistent storage: one SQLite database (bun:sqlite, WAL mode) at
// ~/.board/board.db holding messages, votes, and room->project bindings.
// Full-text search over messages via FTS5 when available (LIKE fallback).
//
// Legacy JSON storage (rooms/*.jsonl, rooms/*.votes.json, projects.json) is
// imported automatically on first open; originals are kept as *.pre-sqlite.
// `board export <room>` re-emits a room as JSONL for grepping/archiving.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, Vote } from "./protocol";

export const dataDir = process.env.BOARD_DIR ?? join(homedir(), ".board");

let db: Database | null = null;
let fts = false;

interface MessageRow {
  room: string;
  seq: number;
  id: string;
  sender: string;
  kind: string;
  text: string;
  ts: number;
  data: string | null;
}

const toMessage = (r: MessageRow): ChatMessage => ({
  type: "message",
  id: r.id,
  seq: r.seq,
  room: r.room,
  from: r.sender,
  kind: r.kind as ChatMessage["kind"],
  text: r.text,
  ts: r.ts,
  ...(r.data ? { data: JSON.parse(r.data) } : {}),
});

function getDb(): Database {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, "board.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      room   TEXT NOT NULL,
      seq    INTEGER NOT NULL,
      id     TEXT NOT NULL,
      sender TEXT NOT NULL,
      kind   TEXT NOT NULL,
      text   TEXT NOT NULL,
      ts     INTEGER NOT NULL,
      data   TEXT,
      PRIMARY KEY (room, seq)
    );
    CREATE TABLE IF NOT EXISTS votes (
      room TEXT NOT NULL,
      id   TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (room, id)
    );
    CREATE TABLE IF NOT EXISTS projects (
      room TEXT PRIMARY KEY,
      dir  TEXT NOT NULL
    );
  `);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(text, content='messages', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    fts = true;
  } catch {
    fts = false; // this sqlite build lacks FTS5; search falls back to LIKE
  }
  migrateLegacy(db);
  return db;
}

// --- legacy import ---------------------------------------------------------

function migrateLegacy(db: Database) {
  const hasRows = (db.query("SELECT 1 FROM messages LIMIT 1").get() ??
    db.query("SELECT 1 FROM projects LIMIT 1").get()) != null;
  if (hasRows) return;

  const roomsDir = join(dataDir, "rooms");
  const projectsFile = join(dataDir, "projects.json");
  let migrated = 0;

  if (existsSync(roomsDir)) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO messages (room, seq, id, sender, kind, text, ts, data) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insertVote = db.prepare("INSERT OR REPLACE INTO votes (room, id, json) VALUES (?,?,?)");
    db.transaction(() => {
      for (const file of readdirSync(roomsDir)) {
        if (file.endsWith(".jsonl")) {
          for (const line of readFileSync(join(roomsDir, file), "utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line) as ChatMessage;
              insert.run(m.room, m.seq, m.id, m.from, m.kind, m.text, m.ts,
                m.data ? JSON.stringify(m.data) : null);
              migrated++;
            } catch {
              // skip corrupt lines
            }
          }
        } else if (file.endsWith(".votes.json")) {
          const room = file.slice(0, -".votes.json".length);
          try {
            for (const v of JSON.parse(readFileSync(join(roomsDir, file), "utf8")) as Vote[]) {
              insertVote.run(room, v.id, JSON.stringify(v));
              migrated++;
            }
          } catch {
            // skip corrupt votes file
          }
        }
      }
    })();
    if (migrated > 0) renameSync(roomsDir, `${roomsDir}.pre-sqlite`);
  }

  if (existsSync(projectsFile)) {
    try {
      const map = JSON.parse(readFileSync(projectsFile, "utf8")) as Record<string, string>;
      const insert = db.prepare("INSERT OR REPLACE INTO projects (room, dir) VALUES (?,?)");
      for (const [room, dir] of Object.entries(map)) {
        insert.run(room, dir);
        migrated++;
      }
    } catch {
      // skip corrupt projects file
    }
    renameSync(projectsFile, `${projectsFile}.pre-sqlite`);
  }

  if (migrated > 0) {
    console.error(`board: migrated ${migrated} records from legacy JSON storage into board.db (backups: *.pre-sqlite)`);
  }
}

// --- messages --------------------------------------------------------------

export function appendMessage(msg: ChatMessage) {
  getDb()
    .prepare("INSERT INTO messages (room, seq, id, sender, kind, text, ts, data) VALUES (?,?,?,?,?,?,?,?)")
    .run(msg.room, msg.seq, msg.id, msg.from, msg.kind, msg.text, msg.ts,
      msg.data ? JSON.stringify(msg.data) : null);
}

/** The most recent `limit` messages of a room, oldest first. */
export function loadHistory(room: string, limit = 1000): ChatMessage[] {
  const rows = getDb()
    .query("SELECT * FROM messages WHERE room = ? ORDER BY seq DESC LIMIT ?")
    .all(room, limit) as MessageRow[];
  return rows.reverse().map(toMessage);
}

/** The first `limit` messages with seq > since, oldest first (deep-history pagination). */
export function messagesAfter(room: string, since: number, limit = 200): ChatMessage[] {
  const rows = getDb()
    .query("SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .all(room, since, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function maxSeq(room: string): number {
  const row = getDb().query("SELECT MAX(seq) AS s FROM messages WHERE room = ?").get(room) as { s: number | null };
  return row.s ?? 0;
}

/** Full-text search within a room, newest first. */
export function searchMessages(room: string, q: string, limit = 50): ChatMessage[] {
  const d = getDb();
  if (fts) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    const rows = d
      .query(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.room = ? ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(phrase, room, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  const rows = d
    .query("SELECT * FROM messages WHERE room = ? AND text LIKE ? ORDER BY seq DESC LIMIT ?")
    .all(room, `%${q}%`, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function listRoomsOnDisk(): string[] {
  const rows = getDb()
    .query("SELECT DISTINCT room FROM messages UNION SELECT room FROM projects")
    .all() as { room: string }[];
  return rows.map((r) => r.room);
}

// --- votes -----------------------------------------------------------------

export function loadVotes(room: string): Vote[] {
  const rows = getDb().query("SELECT json FROM votes WHERE room = ? ORDER BY rowid").all(room) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json));
}

export function saveVotes(room: string, votes: Vote[]) {
  const d = getDb();
  const insert = d.prepare("INSERT OR REPLACE INTO votes (room, id, json) VALUES (?,?,?)");
  d.transaction(() => {
    d.prepare("DELETE FROM votes WHERE room = ?").run(room);
    for (const v of votes) insert.run(room, v.id, JSON.stringify(v));
  })();
}

// --- projects --------------------------------------------------------------

export function loadProjects(): Record<string, string> {
  const rows = getDb().query("SELECT room, dir FROM projects").all() as { room: string; dir: string }[];
  return Object.fromEntries(rows.map((r) => [r.room, r.dir]));
}

export function saveProjects(projects: Record<string, string>) {
  const d = getDb();
  const insert = d.prepare("INSERT OR REPLACE INTO projects (room, dir) VALUES (?,?)");
  d.transaction(() => {
    d.prepare("DELETE FROM projects").run();
    for (const [room, dir] of Object.entries(projects)) insert.run(room, dir);
  })();
}
