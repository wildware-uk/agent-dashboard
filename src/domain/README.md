# `src/domain` — business rules

**One job:** every rule in the product. Projects, updates, agents, sessions,
tasks, messages, approvals. Plain arguments in, plain objects out.

**May import:** `$db`, `$events`, `$media`, `$config`.

**Must not:** ever see an HTTP or MCP type — no `Request`, no `RequestEvent`, no
tool-call shape, no `Response`. `src/mcp/` and `src/http/` are two interchangeable
front doors onto these functions, which is the only reason the MCP surface and
the browser API cannot drift apart in behaviour.

Notes carried from the design:

- Presence is derived, never a stored flag: an agent is online if a session
  heartbeat landed within 90s (§4).
- `claim_task` is a single atomic `UPDATE ... WHERE state='todo'`; the loser gets
  a clean "already claimed" error (§5).
- The approval gate is a bounded long-poll with durable resume: park on the event
  bus for at most `HOLD_S`, otherwise return `pending` for the agent to poll
  (§5).

Public entry point: `src/domain/index.ts`.
