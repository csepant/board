// Small WebSocket client for rooms — used by the TUI and by TypeScript agents.
// Reconnects automatically and resumes from its last seen cursor, so callers
// never see duplicate messages across reconnects.

import type {
  ActivityFrame,
  ChatMessage,
  Kind,
  PresenceFrame,
  ServerFrame,
  WelcomeFrame,
} from "./protocol";
import { DEFAULT_PORT } from "./protocol";

export interface BoardClientOptions {
  room: string;
  name: string;
  kind?: Kind;
  port?: number;
  host?: string;
  onWelcome?: (welcome: WelcomeFrame) => void;
  onMessage?: (msg: ChatMessage) => void;
  onPresence?: (presence: PresenceFrame) => void;
  onActivity?: (activity: ActivityFrame) => void;
  onStatus?: (status: string) => void;
}

export class BoardClient {
  cursor = 0;
  private ws?: WebSocket;
  private closed = false;
  private retries = 0;
  /** Messages sent while disconnected; flushed after the next welcome. */
  private outbox: string[] = [];

  constructor(private opts: BoardClientOptions) {}

  /** Number of messages queued waiting for a connection. */
  get pending(): number {
    return this.outbox.length;
  }

  get url(): string {
    return `ws://${this.opts.host ?? "localhost"}:${this.opts.port ?? DEFAULT_PORT}/ws`;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      ws.send(
        JSON.stringify({
          type: "join",
          room: this.opts.room,
          name: this.opts.name,
          kind: this.opts.kind ?? "human",
          since: this.cursor > 0 ? this.cursor : undefined,
        }),
      );
    };

    ws.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case "welcome":
          this.cursor = Math.max(this.cursor, frame.cursor);
          this.opts.onWelcome?.(frame);
          for (const text of this.outbox.splice(0)) {
            ws.send(JSON.stringify({ type: "message", text }));
          }
          break;
        case "message":
          this.cursor = Math.max(this.cursor, frame.seq);
          this.opts.onMessage?.(frame);
          break;
        case "presence":
          this.opts.onPresence?.(frame);
          break;
        case "activity":
          this.opts.onActivity?.(frame);
          break;
        case "error":
          this.opts.onStatus?.(`server error: ${frame.message}`);
          break;
      }
    };

    ws.onclose = () => {
      if (this.closed) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retries++);
      this.opts.onStatus?.(`disconnected — retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      // onclose fires right after; reconnect is handled there
    };
  }

  /**
   * Send now if connected, otherwise queue for the next welcome.
   * Returns false only when the queue overflowed and the message was dropped.
   */
  send(text: string): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "message", text }));
      return true;
    }
    if (this.outbox.length >= 100) return false;
    this.outbox.push(text);
    return true;
  }

  /**
   * Broadcast an ephemeral activity frame (live tool-use status). Fire-and-
   * forget: dropped when disconnected, never queued — activity is ephemeral.
   */
  sendActivity(tool: string, detail: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "activity", tool, detail }));
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
