# `src/domain` — business rules

**One job:** every rule in the product. Projects, updates, agents, sessions,
tasks, messages, owner requests. Plain arguments in, plain objects out.

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
| `messages.ts` | `postMessage`, `readMessages`, `listThread`, `countUnreadMessages`.                   |
| `tasks.ts`    | `createTask`, `listTasks`, `claimTask`, `completeTask`, `cancelTask`, `assignTask`.   |

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
- **Unread is a cursor, never a flag** (§3): `read_cursors` holds one integer per
  reader **per project** (migration 025), so "unread" is `messages.seq` against
  the cursor for that message's own project, and a second reader is a row rather
  than a migration. Per project because the owner's sessions share one bearer
  token: with a single integer, a session catching up in its own project dragged
  the cursor past another project's unread and made it unannounceable — the
  stream computes what to announce from exactly that comparison. `readMessages`
  moves only the cursors of the projects it read, and a read started from an
  explicit `since` still stops short of anything it stepped over. The
  consequence is at-least-once delivery: the same message can come back twice,
  and cannot silently vanish. The heartbeat's `unreadMessages` count is the same
  comparison, so the two can never disagree.
- **A claim is one statement** (§5): `claimTask` is a single
  `UPDATE tasks SET state='claimed' … WHERE id = ? AND state = 'todo'`, so of two
  agents racing for the same task SQLite picks the winner and the loser's update
  touches nothing. The loser's _message_ comes from re-reading the row
  afterwards, which is safe precisely because the outcome was already decided by
  the failed write. `completeTask` works the same way: the "is this still your
  claim" check is part of the statement, not a read before it.
- **The owner assigns; the agent claims.** A task the owner targeted at one agent
  may only be claimed by that agent, and that one check _is_ a read before the
  write — deliberately, because assignees change in a browser rather than in a
  race, and the guarantee that matters (one claimant) does not depend on it.
- **`openTasks` in a heartbeat is this agent's own `todo` and `claimed` rows.**
  An unclaimed task on the queue is not work anybody has been given, and counting
  it would tell every agent in the deployment it had something to do.
- **`messages.author` is a string, not a foreign key** (§3): the literal `human`,
  or `agent:<agent_id>`. There is no user table in a single-owner deployment, and
  a nullable `agent_id` plus a flag would be two columns encoding one fact.
  `authorText` and `parseAuthor` are the only places that format is written.
- **A message's project comes from what it hangs off.** A reply on an update
  takes the update's project; naming a project that contradicts it is refused
  rather than reconciled, because quietly filing a message somewhere the caller
  did not ask for and reporting success is worse than a 400.
- **`heartbeat` piggybacks `{unreadMessages, openTasks, pendingApprovals}`** so an
  agent never polls three tools to find work (§5). Each count is one function in
  `WORK_COUNTERS`; the slices that own tasks, messages and owner requests replaced
  one entry each and the response shape never moved. `pendingApprovals` keeps its
  name because it is the field agents already parse: an approval is one kind of
  owner request, and renaming the wire format for a word would break clients.
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
- **An owner request is a bounded long-poll with durable resume** (§5). `text`,
  `confirm`, `buttons`, `choice` and `multi_choice` are one mechanism:
  `requestInput` writes a row, publishes `request.created`, and parks on the event
  bus for at most `HOLD_S`; if nobody answered it returns `pending` and the agent
  resumes with `awaitRequest`. The wait lives in the database rather than in a
  socket, so a _fresh process_ can resume a request it never made, and every
  waiter on one request unblocks on the same `request.answered`.
- **Every answer is validated against the request that asked for it**
  (`validateAnswer`, inside `answerRequest`). A `choice` must be one of the
  options offered, a `multi_choice` must respect `min`/`max`, a `text` answer its
  length bounds. This is the security boundary of that slice: the agent acts on
  the value, and the browser posting it is not trustworthy.
- **`expires_at` and a dismissal are the two ways a request ends without an
  answer.** Both settle the row and publish the same `request.answered`, so a
  parked agent hears `timeout` or `cancelled` rather than hanging.
  `startRequestSweeper()` clears the ones nobody is holding.

Public entry point: `src/domain/index.ts`.
