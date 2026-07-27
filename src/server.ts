// The room server: WebSocket + HTTP on one port.
//
//   bun src/server.ts [--port 7077]
//
// Rooms are created on first use. Messages are broadcast to WebSocket
// subscribers and also available over HTTP long-polling, so an agent can
// participate with nothing but curl.

import type { Server, ServerWebSocket } from "bun";
import type { ChatMessage, ClientFrame, Kind, Participant, WelcomeFrame } from "./protocol";
import { DEFAULT_PORT, MAX_TEXT_LENGTH, sanitizeName, sanitizeRoom } from "./protocol";
import { appendMessage, listRoomsOnDisk, loadHistory } from "./store";

interface WSData {
  room?: string;
  name?: string;
  kind?: Kind;
}

interface Room {
  name: string;
  history: ChatMessage[];
  seq: number;
  participants: Map<ServerWebSocket<WSData>, Participant>;
  waiters: Array<() => void>;
}

const rooms = new Map<string, Room>();
let server: Server<WSData>;

const topic = (room: string) => `room:${room}`;

function getRoom(name: string): Room {
  let room = rooms.get(name);
  if (!room) {
    const history = loadHistory(name);
    room = {
      name,
      history,
      seq: history.at(-1)?.seq ?? 0,
      participants: new Map(),
      waiters: [],
    };
    rooms.set(name, room);
  }
  return room;
}

function participantList(room: Room): Participant[] {
  return [...room.participants.values()];
}

function postMessage(room: Room, from: string, kind: Kind, text: string): ChatMessage {
  const msg: ChatMessage = {
    type: "message",
    id: crypto.randomUUID().slice(0, 8),
    seq: ++room.seq,
    room: room.name,
    from,
    kind,
    text: text.slice(0, MAX_TEXT_LENGTH),
    ts: Date.now(),
  };
  room.history.push(msg);
  if (room.history.length > 2000) room.history.splice(0, room.history.length - 1000);
  appendMessage(msg);
  server.publish(topic(room.name), JSON.stringify(msg));
  for (const wake of room.waiters.splice(0)) wake();
  return msg;
}

function broadcastPresence(room: Room, event: "join" | "leave", who: Participant) {
  server.publish(
    topic(room.name),
    JSON.stringify({
      type: "presence",
      event,
      name: who.name,
      kind: who.kind,
      participants: participantList(room),
      ts: Date.now(),
    }),
  );
}

/** Unique name within the room: "sam" -> "sam-2" if taken. */
function dedupeName(room: Room, wanted: string): string {
  const taken = new Set([...room.participants.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

async function messagesSince(room: Room, since: number, waitSec: number, limit: number) {
  let messages = room.history.filter((m) => m.seq > since);
  if (messages.length === 0 && waitSec > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(waitSec, 60) * 1000);
      room.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    messages = room.history.filter((m) => m.seq > since);
  }
  if (limit > 0) messages = messages.slice(-limit);
  return { messages, cursor: room.seq };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

export function startServer(port: number = DEFAULT_PORT): Server<WSData> {
  server = Bun.serve<WSData, never>({
    port,
    idleTimeout: 120,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/ws") {
        if (srv.upgrade(req, { data: {} })) return;
        return json({ error: "websocket upgrade failed" }, 400);
      }

      if (path === "/" || path === "/health") {
        return json({ ok: true, name: "board", rooms: rooms.size });
      }

      if (path === "/rooms" && req.method === "GET") {
        const names = new Set([...listRoomsOnDisk(), ...rooms.keys()]);
        const list = [...names].sort().map((name) => {
          const room = rooms.get(name);
          return {
            name,
            participants: room ? participantList(room) : [],
            cursor: room ? room.seq : loadHistory(name).at(-1)?.seq ?? 0,
          };
        });
        return json({ rooms: list });
      }

      const match = path.match(/^\/rooms\/([^/]+)\/messages$/);
      if (match) {
        const room = getRoom(sanitizeRoom(decodeURIComponent(match[1])));

        if (req.method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0) || 0;
          const wait = Number(url.searchParams.get("wait") ?? 0) || 0;
          const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
          return json(await messagesSince(room, since, wait, limit));
        }

        if (req.method === "POST") {
          let body: { from?: string; text?: string; kind?: Kind };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ error: "body must be JSON: {from, text, kind?}" }, 400);
          }
          if (!body.from || typeof body.text !== "string" || body.text.length === 0) {
            return json({ error: "required fields: from (string), text (non-empty string)" }, 400);
          }
          const kind: Kind = body.kind === "human" ? "human" : "agent";
          const msg = postMessage(room, sanitizeName(body.from), kind, body.text);
          return json({ ok: true, seq: msg.seq, id: msg.id });
        }
      }

      return json({ error: "not found" }, 404);
    },

    websocket: {
      message(ws, raw) {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "frames must be JSON" }));
          return;
        }

        if (!ws.data.room) {
          if (frame.type !== "join" || !frame.room || !frame.name) {
            ws.send(JSON.stringify({ type: "error", message: "first frame must be {type:'join', room, name}" }));
            ws.close();
            return;
          }
          const room = getRoom(sanitizeRoom(frame.room));
          const name = dedupeName(room, sanitizeName(frame.name));
          const kind: Kind = frame.kind === "agent" ? "agent" : "human";
          ws.data = { room: room.name, name, kind };
          room.participants.set(ws, { name, kind });
          ws.subscribe(topic(room.name));

          const since = frame.since ?? 0;
          const welcome: WelcomeFrame = {
            type: "welcome",
            room: room.name,
            you: name,
            participants: participantList(room),
            history: since > 0 ? room.history.filter((m) => m.seq > since) : room.history.slice(-50),
            cursor: room.seq,
          };
          ws.send(JSON.stringify(welcome));
          broadcastPresence(room, "join", { name, kind });
          return;
        }

        if (frame.type === "message" && typeof frame.text === "string" && frame.text.length > 0) {
          const room = getRoom(ws.data.room);
          postMessage(room, ws.data.name!, ws.data.kind!, frame.text);
        }
      },

      close(ws) {
        if (!ws.data.room) return;
        const room = getRoom(ws.data.room);
        const who = room.participants.get(ws);
        room.participants.delete(ws);
        if (who) broadcastPresence(room, "leave", who);
      },
    },
  });

  return server;
}

if (import.meta.main) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : DEFAULT_PORT;
  const srv = startServer(port);
  console.log(`board server listening on http://localhost:${srv.port}`);
}
