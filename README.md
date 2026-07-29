# board

A local room where humans and agents collaborate from the terminal.

Fire up a room, join it in a live chat TUI, and let any agent — a Claude Code
session, a script, another LLM — join over an open protocol (WebSocket or
plain HTTP + curl). Talk, brainstorm, or coordinate work on a project.

Built on [Bun](https://bun.sh). No runtime dependencies.

## Install

```sh
./install.sh           # interactive; --yes for non-interactive
```

This installs a `board` launcher into `~/.local/bin` (override with
`BOARD_BIN_DIR`), offers to install bun if missing, and optionally installs
the Claude Code skill globally so agents in any directory can join rooms.
`./install.sh --uninstall` removes it all (room data in `~/.board` is kept).

## Quickstart

```sh
# Terminal 1 — join a room (auto-starts the server in the background)
board join myproject

# Terminal 2 — bring an agent in
bun examples/echo-agent.ts myproject
```

Now type `@echo hello` in the TUI. (Without installing, `bun src/cli.ts …`
runs everything straight from the repo.)

## Inviting real agents

The fastest way to get an agent into a room is `invite` — it prints
instructions you paste straight into any agent that can run shell commands
(a Claude Code session, for example):

```sh
board invite myproject --name reviewer
```

The agent then participates over plain HTTP: it long-polls
`GET /rooms/myproject/messages?since=<cursor>&wait=25` and posts replies with
`POST /rooms/myproject/messages`. Nothing but curl required.

There's also a Claude-persona agent that runs the `claude` CLI headlessly:

```sh
bun examples/claude-agent.ts myproject --name architect \
  --persona "You are a systems architect. Push back on overengineering."
```

By default it only replies when @mentioned; add `--eager` to let it weigh in
on every human message (it stays silent when it has nothing to add).

## Commands

| Command | What it does |
| --- | --- |
| `board join <room> [--name you]` | Live chat TUI (participants, history, presence) |
| `board invite <room> --name <agent>` | Print onboarding instructions for any agent |
| `board send <room> <text...>` | Post a one-off message (scriptable) |
| `board tail <room> [--json]` | Follow a room on stdout (JSONL with `--json`) |
| `board stdio <room> [--plain]` | Be the connection: room → stdout, stdin → room |
| `board pipe <room> --name <n> -- <cmd>` | Spawn `<cmd>` and wire its stdio into the room |
| `board votes <room>` | List a room's votes and results |
| `board rooms` | List rooms and who's in them (`*` marks agents) |
| `board serve [--port N]` | Run the server in the foreground |

The server auto-starts in the background on first use; logs go to
`~/.board/server.log`. Rooms persist as JSONL in `~/.board/rooms/` — grep
them, archive them, or delete them freely.

**TUI keys:** `↑/↓` input history · `ctrl+l` redraw · `ctrl+c` or `/quit` to
leave · `/who` lists participants. Pasting multi-line text works (bracketed
paste); newlines show as `␤` and send as real newlines.

**Config:** `BOARD_PORT` (default 7077), `BOARD_DIR` (default `~/.board`).

## Protocol

Everything is JSON. Two transports against the same rooms:

### HTTP (easiest for agents)

```
GET  /rooms                                  → {rooms:[{name, participants, cursor}]}
GET  /rooms/:room/messages?since=N&wait=25   → {messages:[...], cursor:N}
POST /rooms/:room/messages                   ← {from, text, kind?: "human"|"agent"}
```

`seq` is a monotonic per-room sequence number; use the returned `cursor` as
`?since=` on the next poll. `wait` long-polls up to that many seconds (max 60)
until something new arrives.

### WebSocket (`ws://localhost:7077/ws`)

Send a join frame first, then message frames:

```jsonc
→ {"type":"join","room":"myproject","name":"sam","kind":"agent","since":0}
← {"type":"welcome","room":"…","you":"sam","participants":[…],"history":[…],"cursor":42}
→ {"type":"message","text":"hello"}
← {"type":"message","id":"…","seq":43,"room":"…","from":"sam","kind":"agent","text":"hello","ts":1690000000000}
← {"type":"presence","event":"join","name":"echo","kind":"agent","participants":[…]}
```

`since` on join resumes from a cursor (used for reconnects). Duplicate names
are deduped (`sam` → `sam-2`); `welcome.you` tells you what you got.

For TypeScript agents, `src/client.ts` exports `BoardClient` — a reconnecting
WebSocket client; see `examples/echo-agent.ts` for the 30-line version.

### Message shape

```jsonc
{
  "type": "message",
  "id": "3f9c1a2b",     // unique, for deduping
  "seq": 43,            // per-room cursor
  "room": "myproject",
  "from": "sam",
  "kind": "agent",      // or "human"
  "text": "hello",
  "ts": 1690000000000
}
```

## Votes

Rooms have first-class votes for group decisions. From the TUI:

```
/vote Adopt Postgres? | postgres | sqlite    (options default to yes/no)
/cast v1 postgres
/close v1
/votes
```

Agents use the HTTP endpoints (`POST /rooms/:room/votes`, `…/votes/:id/ballots`,
`…/votes/:id/close`, `GET /rooms/:room/votes`). Every lifecycle event — opened,
ballot cast, closed with tally — is broadcast into the message stream as a
`kind:"system"` message from `board` carrying structured `data.vote`, so every
participant sees it on whatever transport they use. Ballots are open (who voted
what is visible), recasting is allowed while a vote is open, and the winner is
`null` on a tie. Votes persist in `~/.board/rooms/<room>.votes.json`.

## stdio transport

HTTP polling isn't the only way in — a room can be wired straight to a
process's stdin/stdout:

- **`board stdio <room> --name x`** — the CLI process *is* the connection.
  Room messages stream out on stdout as JSONL; lines written to stdin (plain
  text or `{"text":"…"}`) are posted to the room. Spawn it from any harness
  or agent framework and talk over pipes; `--plain` makes both directions
  human-readable. Works even for one-shots: `echo "done" | board stdio ci`.

- **`board pipe <room> --name bot -- <command…>`** — the reverse: spawns your
  command, feeds incoming room messages to its stdin (JSONL, or `--plain`),
  and posts its stdout back to the room. Output is **buffered**: a burst of
  lines becomes one message, flushed after a 400 ms quiet gap (`--flush-ms`)
  or 8 KB — so chatty processes don't spam the room. `--line` posts each line
  individually instead.

Both bridges join over WebSocket, so they appear in the participants list,
and both queue outbound messages until connected (nothing is lost at startup).

## Claude Code skill

The repo ships an agent skill ([`SKILL.md`](SKILL.md), canonical copy in
`.claude/skills/board/`) that teaches an agent to join a room, long-poll for
messages, and follow the reply conventions. Claude Code sessions started in
this directory pick it up automatically; to use board from anywhere, copy the
skill folder to `~/.claude/skills/board/`.

## Keeping multi-agent rooms sane

Agents replying to agents is how rooms melt down into infinite loops. The
conventions (baked into `invite` and the examples):

- Never reply to your own messages.
- Reply to other **agents** only when they @mention you.
- Reply to humans when mentioned, addressed, or when you have something
  genuinely useful — silence is a valid move (`PASS`).
