# `src/domain` — business rules

**One job:** every rule in the product. Projects, updates, agents, sessions,
tasks, messages, approvals. Plain arguments in, plain objects out.

**May import:** `$db`, `$events`, `$media`, `$config`.

**Must not:** ever see an HTTP or MCP type — no `Request`, no `RequestEvent`, no
tool-call shape, no `Response`. `src/mcp/` and `src/http/` are two interchangeable
front doors onto these functions, which is the only reason the MCP surface and
the browser API cannot drift apart in behaviour.

## The template

`projects.ts` and `updates.ts` are the pattern every later module copies.

```ts
import { context, createProject, listUpdates, postUpdate } from '$domain';

const ctx = context(); // production: the process-wide db, bus and clock
const { project, created } = createProject(ctx, { name: 'Agent Dashboard' });
postUpdate(ctx, { project: project.slug, agentId, body: '# shipped', level: 'success' });
const { updates, nextCursor } = listUpdates(ctx, { project: 'agent-dashboard', limit: 50 });
```

- **`ctx` first, then plain arguments.** A `DomainContext` is `{ db, bus, now }`.
  No module-level singletons, so a test hands over an in-memory database, a
  private bus and a clock it drives; `context()` fills in the real ones.
- **Plain objects out** — `$db` row types and small result records. Never a
  `Response`, never a class the caller has to know how to serialise.
- **Failures are a `DomainError` with a `code`**: `invalid_argument`,
  `not_found`, `conflict`. The domain does not know whether the caller wants a
  404 or a tool error, so each adapter maps the code onto its own vocabulary.
  Anything else escaping the domain is a bug, not a report.
- **Exactly one event per write, published after the write lands.** A call that
  writes nothing — an idempotent create, a repeated delete — publishes nothing.
- **Timestamps come from `ctx.now()`**, read once per call, and are milliseconds
  since the epoch as `$db` stores them.
- `./testing.ts` is a second, test-only entry point (`harness()`), deliberately
  not re-exported from `index.ts`.

## What is here

| File          | Holds                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| `context.ts`  | `DomainContext` and `context()`: the db, the bus and the clock every rule works from. |
| `errors.ts`   | `DomainError` and its three codes.                                                    |
| `slug.ts`     | Slug generation, validation and normalisation.                                        |
| `text.ts`     | The required/optional string checks the rules share.                                  |
| `projects.ts` | `createProject`, `listProjects`, `updateProject`, `findProject`, `resolveProject`.    |
| `updates.ts`  | `postUpdate`, `listUpdates`, `deleteUpdate`.                                          |

Decisions worth knowing before changing them:

- **`createProject` is idempotent on slug** (§5): an agent re-running its
  bootstrap gets its project back, `created: false`, and the stored row
  untouched. A create is not a covert update.
- **A project reference is a slug or an id** (§5). `resolveProject` tries both
  either way round, because a 26-digit slug is also a legal ULID shape.
- **`listUpdates` pages by `seq` cursor, never by offset**, so a page cannot
  shift while agents post above it. One extra row is fetched to answer
  "is there more?" without a second query.
- **Deletes are soft** (§3): `deleteUpdate` sets `deleted_at`, the row survives,
  and `update.deleted` tells a browser to drop a card it has already rendered.
- Presence is derived, never a stored flag: an agent is online if a session
  heartbeat landed within 90s (§4).
- `claim_task` is a single atomic `UPDATE ... WHERE state='todo'`; the loser gets
  a clean "already claimed" error (§5).
- The approval gate is a bounded long-poll with durable resume: park on the event
  bus for at most `HOLD_S`, otherwise return `pending` for the agent to poll
  (§5).

Public entry point: `src/domain/index.ts`.
