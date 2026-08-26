# Agent Dashboard — Design

**Date:** 2026-08-25
**Status:** Approved
**Repo:** `wildware-uk/agent-dashboard` (public, MIT)

## 1. Overview

A self-hosted dashboard where AI coding agents report what they are doing, and their
owner watches and steers in real time.

Agents connect over MCP (remote Streamable HTTP) to create projects, post status
updates with images and video, claim tasks, read messages, and block on human
approval. The owner watches a live feed in a browser, manages projects, assigns
tasks, replies to agents, and answers approval requests.

The product is a single Node process plus SQLite plus a data directory. It is
released publicly for others to self-host.

### Goals

- Agents post rich status updates (markdown + images + video) with no local install.
- Owner sees everything live, with no page refresh.
- Owner can steer: assign tasks, reply to agents, gate agent work behind approval.
- One-command self-host: Docker image, env-var config, no external services.

### Non-goals

- Multi-tenancy. One owner per deployment. No user table, no per-user projects.
- Horizontal scale. One process, one SQLite file. Correct for tens of agents and
  low thousands of updates.
- Agent orchestration. This observes and steers agents; it does not launch them.
- OAuth for MCP. Bearer tokens only, documented as such.

### Success criteria

- An agent with only a URL and a token can post an update with a screenshot, and
  it appears in an already-open browser within one second and without a reload.
- An agent can call `request_approval` and reliably resume waiting across a client
  tool timeout and across its own restart.
- A stranger can `docker compose up`, set four env vars, mint a token, and have a
  working dashboard.

## 2. Architecture

One Node process. Two adapters over one domain core.

```
  agents ──HTTP/MCP──┐                    ┌── browser ──HTTPS──┐
                     v                    v                    |
              src/mcp/  (tool defs)   src/http/ (REST + SSE + media)
                     |                    |                    |
                     +--------+-----------+                    |
                              v                                |
                      src/domain/  (all business rules)        |
                         |        |                            |
                    src/db/   src/events/ ────SSE push─────────+
                              |
                         src/media/
```

Stack: SvelteKit (Node adapter), TypeScript, SQLite via `better-sqlite3` in WAL
mode, `@modelcontextprotocol/sdk` for the MCP server, `zod` for tool schemas,
`sharp` for images, `ffmpeg` for video, Tailwind for styling, Vitest and
Playwright for tests.

Rejected alternatives:

- **Split API + SPA on Postgres with WebSockets.** Correct if this ever becomes
  multi-user or multi-instance. Today it is three processes and a migration tool
  solving problems this deployment does not have.
- **Supabase + Vercel.** Serverless function timeouts break the blocking approval
  gate outright, and media egress costs money on a box that already has an SSD.
- **Local stdio MCP shim.** Would let agents pass local file paths directly, but
  requires an install on every agent machine. Rejected in favour of zero-install
  remote MCP plus a two-step upload.

### Module boundaries

Each module is independently testable and has one job.

| Module | Does | Depends on |
|---|---|---|
| `src/domain/` | All business rules: projects, updates, agents, sessions, tasks, messages, approvals. Plain arguments in, plain objects out. Never sees HTTP or MCP types. | `db`, `events`, `media` |
| `src/db/` | SQLite connection, numbered migrations, one repository module per entity, plain SQL. No business logic. | — |
| `src/events/` | Typed in-process pub/sub. Single fan-out point. Feeds SSE and wakes approval waiters. | — |
| `src/media/` | Upload token mint/verify, ingest with validation, derivative jobs, disk layout. Exposes `ingest()` and `derivativesFor()`; callers never learn paths. | `db`, `events` |
| `src/mcp/` | MCP Streamable HTTP server mounted at `/mcp`. Thin handlers: validate with zod, resolve agent from token, call domain, format result. | `domain` |
| `src/http/` | SvelteKit routes: browser REST, SSE stream, `/mcp` mount, media serving, auth. | `domain`, `mcp`, `media` |
| `src/web/` | Svelte components and client stores. | HTTP API only |

The rule that keeps this honest: **adapters never touch the database, and the
domain never imports an adapter type.** Both `src/mcp/` and `src/http/` are
interchangeable front doors onto the same domain functions, which is why the MCP
surface and the browser API can never drift apart in behaviour.

## 3. Data model

SQLite. Every table has a text ULID `id` (sortable, safe to expose) plus a
`seq INTEGER` autoincrement used for cursor pagination and event ordering.

```
projects        id, slug*, name, description, status(active|archived), pinned,
                created_at, updated_at
agents          id, name, token_hash, created_at, revoked_at, last_seen_at
sessions        id, agent_id, started_at, last_heartbeat_at, ended_at,
                meta(json: host, cwd, model)
updates         id, project_id, agent_id, session_id?, title?, body(md),
                level(info|success|warn|error), pinned, created_at, deleted_at?
media           id, agent_id, update_id?, kind(image|video), mime, bytes, sha256,
                width?, height?, duration_ms?, status(pending|ready|failed),
                created_at
derivatives     media_id, kind(thumb|poster|mp4), path, bytes, width, height
upload_tokens   id, agent_id, media_id, max_bytes, mime_allow, expires_at, used_at?
tasks           id, project_id, agent_id?, title, body,
                state(todo|claimed|done|cancelled),
                created_at, claimed_at?, done_at?, result?
messages        id, project_id?, update_id?, task_id?, author, body, created_at
read_cursors    agent_id, last_seen_message_seq
approvals       id, agent_id, project_id?, update_id?, question, options(json),
                state(pending|approved|rejected|timeout|cancelled), expires_at,
                decided_at?, decided_value?
```

Notes:

- `media.update_id` is nullable because upload precedes the update that references
  it. A `ready` media row with no `update_id` older than one hour is garbage
  collected by the sweeper.
- Deletes are soft (`deleted_at`) so a connected browser can be told to remove a
  row it has already rendered.
- `messages.author` is either the literal `human` or `agent:<agent_id>`.
- Unread state per agent lives in `read_cursors`, not as a flag on `messages`,
  so adding a second reader never requires a schema change.

## 4. Real-time transport

`GET /api/stream` is a single SSE endpoint carrying every event type as JSON, each
with an `id:` set to the global event sequence number.

Event types: `project.created`, `project.updated`, `update.created`,
`update.deleted`, `media.ready`, `task.created`, `task.updated`,
`message.created`, `approval.created`, `approval.decided`, `agent.presence`.

**Reconnect.** The server keeps the last 500 events in an in-memory ring buffer.
On reconnect the browser sends `Last-Event-ID`. If that sequence is still in the
buffer the server replays the gap; otherwise it emits a single `resync` event and
the browser refetches its snapshot. This gives correct behaviour after a laptop
sleeps without a durable event-log table.

**Presence is derived, never stored as a flag.** An agent is online if one of its
sessions has `last_heartbeat_at` within 90 seconds. A background sweeper closes
sessions idle for more than 10 minutes, so approval gates targeting a dead agent
fail loudly rather than hanging.

Any reverse proxy in front of this must not buffer the stream route, or SSE
stalls silently — the page connects and then simply never updates. The reference
deployment uses Caddy, which detects `text/event-stream` on its own but is
configured with an explicit `flush_interval -1` on `/api/stream` so a later
refactor cannot regress it. Behind nginx the equivalent is `proxy_buffering off`.
Both are documented in the README.

## 5. MCP surface

Transport: MCP Streamable HTTP at `POST /mcp`. Auth: `Authorization: Bearer <token>`.

Every tool resolves the calling agent from its token. **No tool accepts an agent
identifier as an argument**, so one agent cannot post as another.

### Feed

- `create_project({name, description?, slug?})` — idempotent on slug; returns the
  existing project if the slug is taken.
- `list_projects({status?})`
- `post_update({project, body, title?, level?, media_ids?})` — `project` accepts a
  slug or an id.
- `create_upload({filename, mime, bytes})` → `{media_id, upload_url, expires_at, max_bytes}`
- `attach_media({update_id, media_ids})` — for media whose processing finishes
  after the update is posted.

### Presence

- `register_session({meta})` → `{session_id, heartbeat_interval_s}`
- `heartbeat({session_id})` → `{ok, unread_messages, open_tasks, pending_approvals}`.
  The piggybacked counts let an agent discover there is work for it without
  polling three separate tools.
- `end_session({session_id})`

### Control plane

- `list_tasks({project?, state?, mine?})`
- `claim_task({task_id})` — a single atomic `UPDATE ... WHERE state='todo'`. The
  losing racer receives a clean "already claimed" error, not a corrupt state.
- `complete_task({task_id, result, post_update?})`
- `get_messages({since?, project?, mark_read?})` — `mark_read` defaults to true and
  advances that agent's cursor.
- `request_input({kind, question, detail?, options?, placeholder?, multiline?, default?, min?, max?, project?, update?, timeout_s?})`
- `await_request({request_id})`

Fourteen tools is real context in every agent's window. If that becomes a problem,
`end_session` and `attach_media` are the first to fold into their neighbours.

### Owner requests

An agent frequently needs something only its owner can supply, and what it needs
depends entirely on the work it was asked to do. Permission is only one shape of
that, so a single versatile tool covers all of them:

| kind | the agent wants | answer |
|---|---|---|
| `text` | free text — a commit message, a name, a missing value | string |
| `confirm` | permission to do something consequential | boolean |
| `buttons` | one action from several — "retry / skip / abort" | the chosen action |
| `choice` | one option picked from a list | one value |
| `multi_choice` | any number of options | list of values |

**The server validates every answer against the request that asked for it**: a
`choice` answer must be one of the offered options, `multi_choice` must respect
`min` and `max`, `text` must respect `max_length`. The agent acts on these answers,
and a browser is not a trustworthy client.

Holding an HTTP request until a human clicks does not work: MCP clients time out
tool calls long before a human necessarily responds, and a dropped connection
loses the wait. Every kind is therefore a **bounded long-poll with durable resume**.

1. `request_input` writes a `pending` row, publishes `request.created`, and the
   browser shows the prompt with the control that kind calls for.
2. The call parks on the event bus for at most `HOLD_S` (default 55 seconds,
   deliberately under the common 60 second client tool timeout).
3. If answered within the hold, it returns `{state: "answered", response, answered_at}`,
   where `response` is `{kind, value}` and `value` is a string, a boolean or a list
   of strings depending on the kind.
4. If still pending, it returns `{state: "pending", request_id, poll_after_ms}`.
   The tool description instructs the agent to call `await_request(request_id)`
   and keep looping while `state === "pending"`.

The wait is durable because the request lives in the database rather than in a
socket: an agent that crashes mid-wait restarts, calls `await_request`, and
resumes. `expires_at` (from `timeout_s`, default one hour) flips the row to
`timeout`. Dismissing the prompt in the UI flips it to `cancelled`. Every parked
waiter unblocks on the same `request.answered` event.

## 6. Media pipeline

1. `create_upload` validates against a mime allowlist — `image/png`, `image/jpeg`,
   `image/webp`, `image/gif`, `video/mp4`, `video/webm`, `video/quicktime` — and a
   size cap. **SVG is explicitly rejected**: it is a script-execution vector.
2. It mints a single-use HMAC-signed token with a 15 minute TTL and returns the
   upload URL.
3. The agent `PUT`s raw bytes to `/api/upload/:token`. The server streams to a temp
   file, **enforcing the byte cap as it writes rather than trusting
   `Content-Length`**, computes sha256 for dedup, and sniffs the real type from
   magic bytes. A declared mime that disagrees with the actual bytes is rejected.
4. An in-process job queue (concurrency 2) produces derivatives: `sharp` for 640w
   and 1600w webp thumbnails with EXIF stripped; `ffmpeg` for a poster frame at
   1 second, plus an h264 mp4 transcode when the source is not web-playable.
5. The row flips to `ready` and publishes `media.ready`, and connected browsers
   swap their placeholder for the real asset live.

Disk layout: `data/media/<id[0:2]>/<id>/{original.ext,thumb-640.webp,thumb-1600.webp,poster.jpg,video.mp4}`.

Serving: `/media/:id/:variant`, immutable cache headers, `X-Content-Type-Options:
nosniff`, `Content-Disposition: inline`, only allowlisted mime types emitted.
The raw upload directory is never served.

## 7. UI

Dark-first, system-aware, Tailwind. Three regions on desktop:

- **Left sidebar** — projects, pinned first, archived collapsed behind a toggle.
- **Centre** — the update timeline, grouped by day. Each card shows a level colour,
  a name-hashed avatar, sanitized markdown, and a media grid with a lightbox.
  Video plays inline.
- **Right rail** — live agents (derived presence) and open tasks.

**Pending requests get a sticky top banner, not a rail item.** A request is the one
case where an agent is stopped dead waiting on the owner, so it must be impossible
to miss. Each kind renders its own control — a text field, a row of action buttons,
a radio list, a checkbox list, approve and reject — and several outstanding requests
queue rather than overwrite one another. Optional browser notification on
`request.created`.

Tasks are a plain per-project list across todo / claimed / done. No drag and drop.

Owner actions: create, rename, pin, archive projects; delete or pin updates;
create and assign tasks; post messages to an agent; approve or reject.

Live behaviour: new items animate in. If the timeline is scrolled away from the
top, a "N new" pill appears rather than the view jumping.

Mobile is a single column with the sidebar as a drawer, because a meaningful share
of glancing at this happens on a phone.

## 8. Security

- **Agent tokens** are 256-bit random, stored as HMAC-SHA256 with a server secret,
  compared in constant time. They are not passwords, so no argon2 is needed.
  Tokens are minted per agent and individually revocable.
- **Owner login** is a single password whose argon2id hash comes from env, granting
  an HttpOnly, Secure, SameSite=Lax signed session cookie. Login is rate limited.
- **Agent-authored markdown is untrusted input.** It renders with raw HTML
  disabled, so no agent can inject script into the owner's browser.
- Per-token rate limits on `/mcp` and on uploads.
- Upload validation as described in section 6: allowlist, streaming size cap,
  magic-byte sniffing, no SVG.

## 9. Testing

- **Domain unit tests** (Vitest) against a fresh in-memory SQLite with migrations
  applied per test.
- **MCP integration tests** drive tools through a real SDK client over real HTTP
  with real auth. This is what catches schema and transport mistakes that unit
  tests cannot.
- **Approval gate tests** use fake timers to prove all five paths: decided during
  hold, hold expiry returning `pending`, resume via `await_approval`, `expires_at`
  producing `timeout`, and a UI cancel unblocking a parked waiter.
- **Media tests** use a fixture png and a one-second mp4, assert derivatives are
  produced, and assert a zip renamed to `.png` is rejected.
- **One Playwright smoke test**: log in, post an update over MCP, assert it appears
  in the browser with no reload. This proves the SSE path end to end.
- CI on GitHub Actions with ffmpeg installed.

## 10. Packaging and deployment

Public release makes these part of the deliverable, not extras.

- Dockerfile on `node:22-slim` with ffmpeg; compose file with a data volume.
- Configuration exclusively via env: `DATA_DIR`, `ADMIN_PASSWORD_HASH`,
  `SESSION_SECRET`, `TOKEN_SECRET`, `PUBLIC_BASE_URL`, `MAX_IMAGE_BYTES`,
  `MAX_VIDEO_BYTES`, `HOLD_S`.
- A `mint-token <name>` CLI, so the first agent token can exist before anyone logs
  in.
- README: quickstart, copy-paste MCP client config for Claude Code and others, the
  nginx SSE caveat, and an honest scope line — single-owner, self-hosted, not
  multi-tenant.
- Backup guidance: an online backup of the SQLite file plus an rsync of
  `data/media/`. The `sqlite3` CLI is not assumed to be installed, so the
  documented path uses the app's own `backup` command (built on the driver's
  online backup API) rather than a shell binary.
- MIT licence, matching `game-bridge-mcp`.

## 11. Build order

Each item is a shippable slice that leaves the tree working.

1. Scaffold: SvelteKit + TS + Tailwind + Vitest, CI, licence, README skeleton.
2. `src/db/`: connection, migration runner, schema, repositories.
3. `src/events/`: typed pub/sub plus the ring buffer.
4. `src/domain/`: projects and updates.
5. `src/mcp/`: server mount, token auth, `create_project` / `list_projects` /
   `post_update`, with integration tests.
6. `src/http/`: owner login and session cookie.
7. SSE endpoint with `Last-Event-ID` replay and resync.
8. Web shell: sidebar, timeline, live update rendering.
9. `src/media/`: upload tokens, ingest with validation, serving.
10. Media derivatives: job queue, sharp, ffmpeg, `media.ready`.
11. Media in the UI: grid, lightbox, inline video, live placeholder swap.
12. Sessions, heartbeat, derived presence, sweeper, right-rail agents.
13. Tasks: domain, MCP tools, UI list, atomic claim.
14. Messages: domain, `get_messages`, read cursors, owner reply UI.
15. Approvals: domain, bounded long-poll with resume, sticky banner UI.
16. Owner management: pin, archive, rename, delete.
17. Packaging: Dockerfile, compose, `mint-token` CLI, full README.
18. Playwright smoke test.

## 12. Reference deployment

The canonical instance runs on the Wildware box:

- Node process listening on **port 8010** (`PORT=8010`, the documented default).
- Public at **https://agents.wildware.dev**, so `PUBLIC_BASE_URL=https://agents.wildware.dev`
  and agents point their MCP client at `https://agents.wildware.dev/mcp`.
- Caddy terminates TLS and reverse-proxies to `127.0.0.1:8010`, with
  `flush_interval -1` on `/api/stream` and a 300s proxy read timeout to cover slow
  video uploads and the 55 second approval-gate holds.
- Data lives on the SSD under the process's `DATA_DIR`.

Because `create_upload` hands back an absolute `upload_url`, `PUBLIC_BASE_URL` must
be the externally reachable origin, not the bind address — an agent that receives a
`127.0.0.1` upload URL cannot upload anything.
