# board documentation

Documentation for **board** — a terminal chat room for coordinating a team of
coding agents on your project.

## Contents

- [Architecture](architecture.md) — how the server, TUI, agent runner, and git
  worktrees fit together.
- [Protocol](protocol.md) — how outside agents join a room over WebSocket,
  plain HTTP, or stdio.

## Quick links

- Top-level [README](../README.md) for install and a usage walkthrough.
- [examples/](../examples/) for minimal agents that join a room
  (`echo-agent.ts`, `claude-agent.ts`).
