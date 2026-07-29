// Full-screen chat TUI: header with participants, scrolling message pane,
// pinned input line. Zero dependencies — raw ANSI with a VT scroll region.

import { StringDecoder } from "node:string_decoder";
import { BoardClient } from "./client";
import type { ChatMessage, Participant, Vote } from "./protocol";
import { DEFAULT_PORT } from "./protocol";

const ESC = "\x1b";
const CSI = `${ESC}[`;

type Entry =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "sys"; text: string; ts: number };

const NAME_COLORS = [110, 150, 179, 176, 209, 72, 139, 167, 117, 144];

export async function runTui(opts: { room: string; name: string; port?: number }) {
  const out = process.stdout;
  const port = opts.port ?? DEFAULT_PORT;
  const write = (s: string) => out.write(s);

  let rows = out.rows || 24;
  let cols = out.columns || 80;

  const entries: Entry[] = [];
  const seenIds = new Set<string>();
  let participants: Participant[] = [];
  let you = opts.name;
  let status = "connecting…";

  // --- input state ---------------------------------------------------------
  let buf = "";
  let cur = 0;
  const inputHistory: string[] = [];
  let historyIdx = -1;
  let draft = "";
  let inPaste = false;
  let pending = ""; // partial escape sequence / paste marker across chunks
  const decoder = new StringDecoder("utf8");

  // --- layout --------------------------------------------------------------
  const headerRow = () => 1;
  const regionTop = () => 2;
  const regionBottom = () => rows - 2;
  const sepRow = () => rows - 1;
  const inputRow = () => rows;
  const regionHeight = () => regionBottom() - regionTop() + 1;

  const dim = (s: string) => `${CSI}2m${s}${CSI}22m`;
  const colorFor = (name: string) => {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    return NAME_COLORS[hash % NAME_COLORS.length];
  };
  const colored = (name: string) => `${CSI}1;38;5;${colorFor(name)}m${name}${CSI}0m`;

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  function wrapText(text: string, width: number): string[] {
    if (width < 8) width = 8;
    const lines: string[] = [];
    for (const raw of text.split("\n")) {
      let line = raw;
      if (line === "") {
        lines.push("");
        continue;
      }
      while (line.length > width) {
        const slice = line.slice(0, width);
        const space = slice.lastIndexOf(" ");
        const cut = space > width * 0.5 ? space : width;
        lines.push(line.slice(0, cut));
        line = line.slice(cut).replace(/^ +/, "");
      }
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  /** Render an entry into already-wrapped, colored terminal lines. */
  function renderEntry(entry: Entry): string[] {
    if (entry.kind === "sys") {
      return wrapText(`— ${entry.text}`, cols - 7).map(
        (line, i) => (i === 0 ? dim(`${fmtTime(entry.ts)} ${line}`) : dim(`      ${line}`)),
      );
    }
    const { msg } = entry;
    const tag = msg.kind === "agent" ? "*" : "";
    const prefixLen = Math.min(5 + 1 + msg.from.length + tag.length + 2, Math.floor(cols / 2));
    const indent = " ".repeat(prefixLen);
    const body = wrapText(msg.text, cols - prefixLen - 1);
    const prefix = `${dim(fmtTime(msg.ts))} ${colored(msg.from)}${tag ? dim(tag) : ""}${dim(":")} `;
    return body.map((line, i) => (i === 0 ? prefix + line : indent + line));
  }

  // --- drawing -------------------------------------------------------------
  function drawHeader() {
    const names = participants
      .map((p) => (p.name === you ? `${p.name} (you)` : p.kind === "agent" ? `${p.name}*` : p.name))
      .join("  ");
    const text = ` #${opts.room}  ·  ${names || "just you"}  ·  ${status}`;
    write(`${CSI}s${CSI}${headerRow()};1H${CSI}2K${CSI}7m${text.slice(0, cols).padEnd(cols)}${CSI}0m${CSI}u`);
  }

  function drawSep() {
    write(`${CSI}${sepRow()};1H${CSI}2K${dim("─".repeat(cols))}`);
  }

  function drawInput() {
    const prompt = "› ";
    const visibleWidth = cols - prompt.length - 1;
    const display = buf.replace(/\n/g, "␤");
    const offset = Math.max(0, cur - visibleWidth);
    const view = display.slice(offset, offset + visibleWidth);
    write(`${CSI}${inputRow()};1H${CSI}2K${dim(prompt)}${view}`);
    write(`${CSI}${inputRow()};${prompt.length + (cur - offset) + 1}H`);
  }

  function fullRedraw() {
    rows = out.rows || 24;
    cols = out.columns || 80;
    write(`${CSI}2J`);
    write(`${CSI}${regionTop()};${regionBottom()}r`);
    drawHeader();
    drawSep();
    const lines = entries.slice(-300).flatMap(renderEntry).slice(-regionHeight());
    const startRow = regionBottom() - lines.length + 1;
    lines.forEach((line, i) => {
      write(`${CSI}${startRow + i};1H${CSI}2K${line}`);
    });
    drawInput();
  }

  function appendEntry(entry: Entry) {
    entries.push(entry);
    if (entries.length > 600) entries.splice(0, entries.length - 400);
    for (const line of renderEntry(entry)) {
      // Scroll the region by newlining at its bottom row, then paint the line.
      write(`${CSI}${regionBottom()};1H\n${CSI}2K${line}`);
    }
    drawInput();
  }

  const sysLine = (text: string) => appendEntry({ kind: "sys", text, ts: Date.now() });

  // --- client --------------------------------------------------------------
  const client = new BoardClient({
    room: opts.room,
    name: opts.name,
    kind: "human",
    port,
    onWelcome: (welcome) => {
      you = welcome.you;
      participants = welcome.participants;
      status = "connected";
      for (const msg of welcome.history) {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          entries.push(msg.kind === "system" ? { kind: "sys", text: msg.text, ts: msg.ts } : { kind: "msg", msg });
        }
      }
      fullRedraw();
      sysLine(`connected to #${welcome.room} as ${welcome.you}`);
    },
    onMessage: (msg) => {
      if (seenIds.has(msg.id)) return;
      seenIds.add(msg.id);
      if (msg.kind === "system") appendEntry({ kind: "sys", text: msg.text, ts: msg.ts });
      else appendEntry({ kind: "msg", msg });
    },
    onPresence: (presence) => {
      participants = presence.participants;
      drawHeader();
      if (presence.name !== you) {
        sysLine(`${presence.name}${presence.kind === "agent" ? " (agent)" : ""} ${presence.event === "join" ? "joined" : "left"}`);
      }
      drawInput();
    },
    onStatus: (s) => {
      status = s;
      drawHeader();
      drawInput();
    },
  });

  // --- input handling ------------------------------------------------------
  function submit() {
    const text = buf.replace(/\s+$/, "");
    buf = "";
    cur = 0;
    historyIdx = -1;
    if (!text.trim()) {
      drawInput();
      return;
    }
    inputHistory.push(text);
    drawInput();

    if (text === "/quit" || text === "/exit" || text === "/q") return quit();
    if (text === "/help") {
      sysLine("agents: /spawn <harness> <name> [role…] · /agents · /kill <name> · /diff <name> · /merge <name>");
      sysLine("votes: /vote <question> [| opt | opt] · /cast <id> <option> · /close <id> · /votes");
      sysLine("misc: /who · /quit · keys: ctrl+c quit, ctrl+l redraw, ↑/↓ input history");
      return;
    }
    const spawn = text.match(/^\/spawn\s+(\S+)\s+(\S+)(?:\s+(.+))?$/);
    if (spawn) {
      void api(`/agents/${spawn[2]}`, "POST", { harness: spawn[1], role: spawn[3] ?? "" }).then(
        (err) => err && sysLine(err),
      );
      return;
    }
    if (text === "/agents") {
      void (async () => {
        try {
          const res = await fetch(`http://localhost:${port}/rooms/${opts.room}/agents`);
          const { agents } = (await res.json()) as {
            agents: { name: string; harness: string; status: string; branch: string }[];
          };
          if (agents.length === 0) return sysLine("no agents — /spawn claude alice [role…]");
          for (const a of agents) sysLine(`${a.name} · ${a.harness} · ${a.status} · ${a.branch}`);
        } catch (e) {
          sysLine(`agents failed: ${e}`);
        }
      })();
      return;
    }
    const kill = text.match(/^\/kill\s+(\S+)$/);
    if (kill) {
      void api(`/agents/${kill[1]}`, "DELETE").then((err) => err && sysLine(err));
      return;
    }
    const diff = text.match(/^\/diff\s+(\S+)$/);
    if (diff) {
      void (async () => {
        try {
          const res = await fetch(`http://localhost:${port}/rooms/${opts.room}/agents/${diff[1]}/diff`);
          const body = (await res.json()) as { error?: string; stat?: string; dirty?: string };
          if (!res.ok) return sysLine(`diff failed: ${body.error}`);
          sysLine(body.stat?.trim() ? body.stat.trim() : "no committed changes vs your tree");
          if (body.dirty?.trim()) sysLine(`uncommitted in worktree:\n${body.dirty.trim()}`);
          sysLine(`full diff: board diff ${diff[1]} (in a terminal)`);
        } catch (e) {
          sysLine(`diff failed: ${e}`);
        }
      })();
      return;
    }
    const merge = text.match(/^\/merge\s+(\S+)$/);
    if (merge) {
      void api(`/agents/${merge[1]}/merge`, "POST").then((err) => err && sysLine(err));
      return;
    }
    if (text === "/who") {
      sysLine(
        `in room: ${participants.map((p) => `${p.name}${p.kind === "agent" ? " (agent)" : ""}`).join(", ") || "nobody"}`,
      );
      return;
    }
    if (text.startsWith("/vote ")) {
      const [question, ...options] = text.slice(6).split("|").map((s) => s.trim());
      void voteApi("", { question, options }).then((err) => err && sysLine(err));
      return;
    }
    if (text === "/votes") {
      void listVotes();
      return;
    }
    const cast = text.match(/^\/cast\s+(\S+)\s+(.+)$/);
    if (cast) {
      void voteApi(`/${cast[1]}/ballots`, { option: cast[2].trim() }).then((err) => err && sysLine(err));
      return;
    }
    const close = text.match(/^\/close\s+(\S+)$/);
    if (close) {
      void voteApi(`/${close[1]}/close`, {}).then((err) => err && sysLine(err));
      return;
    }
    if (!client.send(text)) sysLine("not connected — message not sent");
    drawInput();
  }

  /** Call a room endpoint; returns an error string or null (results arrive as system messages). */
  async function api(path: string, method: string, body?: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch(`http://localhost:${port}/rooms/${opts.room}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify({ from: you, ...body }) } : {}),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        return `failed: ${err.error ?? res.status}`;
      }
      return null;
    } catch (e) {
      return `failed: ${e}`;
    }
  }

  const voteApi = (path: string, body: Record<string, unknown>) => api(`/votes${path}`, "POST", body);

  async function listVotes() {
    try {
      const res = await fetch(`http://localhost:${port}/rooms/${opts.room}/votes`);
      const { votes } = (await res.json()) as { votes: Vote[] };
      if (votes.length === 0) return sysLine("no votes yet — open one with /vote <question> [| opt | opt]");
      for (const v of votes.slice(-10)) {
        const tally = v.options
          .map((o) => `${o} ${Object.values(v.ballots).filter((b) => b === o).length}`)
          .join(" · ");
        sysLine(`${v.id} [${v.status}] "${v.question}" (${tally})${v.result?.winner ? ` → ${v.result.winner}` : ""}`);
      }
    } catch (e) {
      sysLine(`could not list votes: ${e}`);
    }
  }

  function insert(s: string) {
    buf = buf.slice(0, cur) + s + buf.slice(cur);
    cur += s.length;
  }

  function historyNav(dir: -1 | 1) {
    if (inputHistory.length === 0) return;
    if (historyIdx === -1) {
      if (dir === 1) return;
      draft = buf;
      historyIdx = inputHistory.length - 1;
    } else {
      historyIdx += dir;
    }
    if (historyIdx >= inputHistory.length) {
      historyIdx = -1;
      buf = draft;
    } else {
      historyIdx = Math.max(0, historyIdx);
      buf = inputHistory[historyIdx];
    }
    cur = buf.length;
  }

  function handleCsi(seq: string) {
    switch (seq) {
      case "A": historyNav(-1); break;
      case "B": historyNav(1); break;
      case "C": cur = Math.min(buf.length, cur + 1); break;
      case "D": cur = Math.max(0, cur - 1); break;
      case "H": case "1~": cur = 0; break;
      case "F": case "4~": cur = buf.length; break;
      case "3~": buf = buf.slice(0, cur) + buf.slice(cur + 1); break;
      case "200~": inPaste = true; break;
      case "201~": inPaste = false; break;
    }
  }

  function handleChar(ch: string) {
    switch (ch) {
      case "\r": case "\n": submit(); return;
      case "\x7f": case "\b":
        if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; }
        break;
      case "\x03": case "\x04": quit(); return;
      case "\x01": cur = 0; break;
      case "\x05": cur = buf.length; break;
      case "\x0b": buf = buf.slice(0, cur); break;
      case "\x15": buf = buf.slice(cur); cur = 0; break;
      case "\x17": {
        const head = buf.slice(0, cur).replace(/\S+\s*$/, "");
        buf = head + buf.slice(cur);
        cur = head.length;
        break;
      }
      case "\x0c": fullRedraw(); return;
      default:
        if (ch >= " " || ch === "\t") insert(ch);
    }
  }

  const PASTE_END = `${ESC}[201~`;

  function feed(chunk: string) {
    let data = pending + chunk;
    pending = "";
    let i = 0;
    while (i < data.length) {
      if (inPaste) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          // Keep a possible partial end-marker for the next chunk.
          let tail = data.length;
          for (let k = 1; k < PASTE_END.length; k++) {
            if (data.endsWith(PASTE_END.slice(0, k))) tail = data.length - k;
          }
          insert(data.slice(i, tail).replace(/\r\n?/g, "\n"));
          pending = data.slice(tail);
          break;
        }
        insert(data.slice(i, end).replace(/\r\n?/g, "\n"));
        inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }

      const ch = data[i];
      if (ch === ESC) {
        if (i === data.length - 1) { pending = ESC; break; }
        if (data[i + 1] === "[") {
          let j = i + 2;
          while (j < data.length && !/[@-~]/.test(data[j])) j++;
          if (j >= data.length) { pending = data.slice(i); break; }
          handleCsi(data.slice(i + 2, j + 1));
          i = j + 1;
          continue;
        }
        i += 2; // alt+key / lone escape: ignore
        continue;
      }
      handleChar(ch);
      i++;
    }
    drawInput();
  }

  // --- lifecycle -----------------------------------------------------------
  function teardown() {
    write(`${CSI}?2004l`); // bracketed paste off
    write(`${CSI}r`); // reset scroll region
    write(`${CSI}?1049l`); // leave alt screen
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  function quit() {
    client.close();
    teardown();
    process.exit(0);
  }

  if (!out.isTTY || !process.stdin.isTTY) {
    console.error("board join needs an interactive terminal (try `board tail` for scripting)");
    process.exit(1);
  }

  write(`${CSI}?1049h`); // alt screen
  write(`${CSI}?2004h`); // bracketed paste
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => feed(decoder.write(data)));
  out.on("resize", fullRedraw);
  process.on("SIGINT", quit);
  process.on("exit", teardown);

  fullRedraw();
  sysLine(`joining #${opts.room} on localhost:${port} — /help for commands`);
  client.connect();

  // Keep the process alive; quit() exits.
  await new Promise(() => {});
}
