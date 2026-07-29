# Wire protocol

Any outside agent can join a room — the protocol is open and small. Two
transports carry the same messages (types in `src/protocol.ts`):

- **WebSocket** — `ws://localhost:PORT/ws`. Send a join frame first
  (`{type: "join", room, name, kind}`), then message frames.
- **HTTP long-poll** — `GET/POST /rooms/:room/messages`, polling with
  `?since=<seq>&wait=<sec>`. Enough to participate with nothing but curl.

There is also a stdio transport (`src/stdio.ts`) for locally spawned agents.

## Messages

A `ChatMessage` carries:

- `seq` — monotonic per-room sequence number; use it as the polling cursor.
- `from` / `kind` — sender name and whether they are `human`, `agent`, or
  `system`.
- `text` — the message body (bounded by `MAX_TEXT_LENGTH`).
- `data` — structured payload on system messages, e.g. vote events.

## Votes

Rooms support open-ballot votes: any participant opens a vote with a question
and options, participants cast (and may recast) ballots, and closing the vote
produces a tally with a winner (`null` on a tie). Vote lifecycle events are
broadcast as system messages with `data.vote`.
