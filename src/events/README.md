# `src/events` — in-process pub/sub

**One job:** be the single fan-out point. Typed publish/subscribe plus the
in-memory ring buffer that backs SSE reconnects.

**May import:** nothing from `src/` (except `$config`). This is a leaf.

**Must not:** know what an HTTP response or an MCP tool is. It hands events to
subscribers; `src/http/` turns them into an SSE stream.

Notes carried from the design (§4):

- Event types: `project.created`, `project.updated`, `update.created`,
  `update.updated`, `update.deleted`, `media.ready`, `task.created`, `task.updated`,
  `message.created`, `request.created`, `request.answered`, `agent.presence`.
- Every event carries the global sequence number used as the SSE `id:`.
- The last 500 events stay in a ring buffer so a reconnect with `Last-Event-ID`
  can be replayed; a miss emits a single `resync` instead.
- Parked owner-request waiters unblock off `request.answered` published here, which is
  what makes an owner request resumable rather than socket-bound.

## Public surface

`src/events/index.ts` exports:

- `bus` — the process-wide `EventBus`. Everything shares this one instance;
  a second bus would silently split the fan-out. Tests build their own.
- `bus.publish(type, payload)` — stamps the next `seq`, retains the event for
  replay, and fans it out synchronously. Returns the stamped event, so a caller
  can quote its `seq` as a cursor. A payload that does not match its `type` is a
  compile error, which `src/events/bus.test.ts` pins with `@ts-expect-error`
  lines that `npm run typecheck` verifies.
- `bus.subscribe(listener)` — returns an idempotent unsubscribe.
- `bus.replaySince(seq)` — `{ hit: true, events }` or `{ hit: false, reason }`.
  A hit with no events (caller up to date) and a miss (cursor fell out of the
  buffer) are different results: SSE replays the first and sends `resync` for
  the second.
- `bus.waitFor({ types, where, since, timeoutMs, signal })` — parks until a
  matching event, the timeout, or an abort; resolves `undefined` when no match
  arrived, and always unsubscribes. `since` scans the replay buffer first, which
  closes the race between writing a request row and waiting on its answer.
- `AppEvent`, `EventOf<K>`, `EventPayloads`, `EventName` and the small literal
  unions the payloads use.

Public entry point: `src/events/index.ts`.
