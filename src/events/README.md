# `src/events` — in-process pub/sub

**One job:** be the single fan-out point. Typed publish/subscribe plus the
in-memory ring buffer that backs SSE reconnects.

**May import:** nothing from `src/` (except `$config`). This is a leaf.

**Must not:** know what an HTTP response or an MCP tool is. It hands events to
subscribers; `src/http/` turns them into an SSE stream.

Notes carried from the design (§4):

- Event types: `project.created`, `project.updated`, `update.created`,
  `update.deleted`, `media.ready`, `task.created`, `task.updated`,
  `message.created`, `approval.created`, `approval.decided`, `agent.presence`.
- Every event carries the global sequence number used as the SSE `id:`.
- The last 500 events stay in a ring buffer so a reconnect with `Last-Event-ID`
  can be replayed; a miss emits a single `resync` instead.
- Parked approval waiters unblock off `approval.decided` published here, which is
  what makes the approval gate resumable rather than socket-bound.

Public entry point: `src/events/index.ts`.
