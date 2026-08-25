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
| `sessions.ts` | `registerSession`, `heartbeat`, `endSession`, `listLiveAgents`, the sweeper.          |

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
- **Presence is derived, never a stored flag** (§4): an agent is online if one of
  its open sessions beat within `PRESENCE_WINDOW_MS` (90s). There is no `online`
  column, so nothing can be left stuck on, and the browser re-derives the same
  answer from `lastHeartbeatAt` against its own clock.
- **`agent.presence` fires on transitions only.** A heartbeat is the most
  frequent write in the product, and every event reaches every open SSE
  connection, so a beat publishes only when the derivation changes. The
  transition is read from the database either side of the write, so no in-memory
  presence state exists to lose. One consequence is deliberate: crossing the 90s
  line writes nothing, so going quiet is _observed_ by the rail rather than
  announced.
- **`heartbeat` piggybacks `{unreadMessages, openTasks, pendingApprovals}`** so an
  agent never polls three tools to find work (§5). Each count is one function in
  `WORK_COUNTERS`; the slices that own tasks, messages and approvals replace one
  entry each and the response shape never moves.
- **The sweeper closes sessions idle beyond `SESSION_IDLE_MS`** (10 minutes), so
  a gate aimed at a dead agent fails loudly rather than hanging (§4).
  `startPresenceSweeper()` runs it on a timer and is started by
  `src/hooks.server.ts`.
- **Media is reserved before it exists** (§6): `createUpload` mints a single-use
  URL and leaves a `pending` row with an empty `sha256`, which is what "no bytes
  yet" means everywhere downstream. `post_update` takes `media_ids` and refuses
  the whole post if any id is not the caller's to attach; `attach_media` skips
  such ids instead, because retrying it must be safe. Neither publishes an event:
  `media.ready` is the derivative pipeline's announcement, and `update.created`
  goes out _after_ the media is attached so a browser sees a whole card.
- **A browser is told what a media item offers, not where it lives** (§6, §7).
  `listUpdateMedia` answers with the stored dimensions, the status and the
  variants that `/media/:id/:variant` will serve _now_ — asked of `$media` rather
  than reimplemented, so the variant vocabulary has one definition in the module
  that serves it. Paths never leave `$media`, and no URL is built here at all.
- **Orphaned media is collected an hour after upload** (§3). `startMediaSweeper()`
  runs `sweepMedia` every fifteen minutes and is started by `src/hooks.server.ts`
  beside the presence sweeper; it takes `pending` and `failed` rows as well as
  `ready` ones, because an upload token lives fifteen minutes so an hour-old
  reservation can never be filled by anybody.
- **`ingestUpload` and `readMediaVariant` let a `MediaError` through**, unlike
  every other domain function. The upload route has to answer 403, 413 and 415
  distinctly, and flattening those into `invalid_argument` would leave an agent
  retrying blind.
- `claim_task` is a single atomic `UPDATE ... WHERE state='todo'`; the loser gets
  a clean "already claimed" error (§5).
- The approval gate is a bounded long-poll with durable resume: park on the event
  bus for at most `HOLD_S`, otherwise return `pending` for the agent to poll
  (§5).

Public entry point: `src/domain/index.ts`.
