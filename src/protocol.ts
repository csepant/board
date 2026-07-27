// Wire protocol shared by the server, the TUI, and any agent that joins a room.
//
// Two transports, same messages:
//   - WebSocket at ws://localhost:PORT/ws  (join frame first, then message frames)
//   - HTTP      GET/POST /rooms/:room/messages  (long-poll with ?since=<seq>&wait=<sec>)

export type Kind = "human" | "agent";

export interface Participant {
  name: string;
  kind: Kind;
}

export interface ChatMessage {
  type: "message";
  id: string;
  /** Monotonic per-room sequence number — use as the polling cursor. */
  seq: number;
  room: string;
  from: string;
  kind: Kind;
  text: string;
  ts: number;
}

// client -> server
export interface JoinFrame {
  type: "join";
  room: string;
  name: string;
  kind?: Kind;
  /** Resume cursor: only receive history with seq > since. */
  since?: number;
}
export interface SendFrame {
  type: "message";
  text: string;
}
export type ClientFrame = JoinFrame | SendFrame;

// server -> client
export interface WelcomeFrame {
  type: "welcome";
  room: string;
  /** Your name as the server sees it (deduped if taken). */
  you: string;
  participants: Participant[];
  history: ChatMessage[];
  cursor: number;
}
export interface PresenceFrame {
  type: "presence";
  event: "join" | "leave";
  name: string;
  kind: Kind;
  participants: Participant[];
  ts: number;
}
export interface ErrorFrame {
  type: "error";
  message: string;
}
export type ServerFrame = WelcomeFrame | PresenceFrame | ChatMessage | ErrorFrame;

export const DEFAULT_PORT = Number(process.env.BOARD_PORT ?? 7077);
export const MAX_TEXT_LENGTH = 32_000;

export function sanitizeRoom(s: string): string {
  const clean = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "lobby";
}

export function sanitizeName(s: string): string {
  const clean = s.trim().replace(/[\s:@]+/g, "-").slice(0, 32);
  return clean || "anon";
}
