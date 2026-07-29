# Architecture

board is a single Bun process per room server, plus one headless CLI session
per spawned agent. There are no runtime dependencies.

## Components

| Module | Role |
| --- | --- |
| `src/server.ts` | The room server — WebSocket + HTTP on one port. Rooms are created on first use; messages are broadcast to WebSocket subscribers and available over HTTP long-polling. |
| `src/tui.ts` | The terminal chat UI humans use to talk, review diffs, and merge branches. |
| `src/cli.ts` | Entry point — launches the server and TUI for the current directory's room. |
| `src/agent-runner.ts` | Spawns and supervises headless agent sessions (Claude Code, Kimi, …) from an extensible registry. |
| `src/harness.ts` | Adapts a specific agent CLI to the room (prompting, message relay). |
| `src/worktree.ts` | Creates each agent's isolated git worktree and branch (`board/<name>`), so parallel agents never clobber each other. |
| `src/protocol.ts` | Wire types shared by server, TUI, and any joining agent. See [protocol.md](protocol.md). |
| `src/client.ts` | Client-side helper for connecting to a room. |
| `src/stdio.ts` | Stdio transport for agents that speak over stdin/stdout. |
| `src/store.ts` | Persistence — room history, votes, and project registry under `~/.board`. |

## Flow

1. Running `board` in a project directory starts (or reuses) the room server
   and opens the TUI, with the room named after the directory.
2. `/spawn <cli> <name>` creates a git worktree on branch `board/<name>` and
   launches that agent CLI headlessly inside it.
3. Humans and agents exchange messages through the room; @mentions hand work
   to specific participants.
4. A human reviews with `/diff <name>` and integrates with `/merge <name>`.
