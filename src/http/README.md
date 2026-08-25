# `src/http` — the browser-facing adapter

**One job:** the SvelteKit routes. Browser REST, the SSE stream, the `/mcp`
mount, media serving, and owner auth.

**May import:** `$domain`, `$mcp`, `$media`, `$config`, `$web` — a route has to
render the components that live there — and `$events`, which the SSE stream
subscribes to. The design table omits both edges; the architecture diagram in §2
draws the second one (`src/events/ ──SSE push──> browser` passes through here)
and §4 makes this module the reader of the replay ring buffer. Both arrows only
point this way: `$web` or `$events` importing `$http` remains a failure.

**Must not:** touch the database, and must not hold business rules. A route
validates, calls domain, and serialises. The bus is read, never reasoned with:
`src/http/` subscribes and serialises `AppEvent`s, and never decides what is
worth publishing.

**`src/http/routes/` is the SvelteKit route tree.** `vite.config.ts` sets
`files.routes` to it, so there is no `src/routes/`.

Notes carried from the design:

- `GET /api/stream` is the single SSE endpoint. On reconnect it honours
  `Last-Event-ID` from the events ring buffer, or emits `resync` (§4).
- Behind nginx the stream route needs `proxy_buffering off`, or SSE dies
  silently (§4). The full snippet is in a comment at the route itself,
  `routes/api/stream/+server.ts`, because that is where anyone debugging a dead
  feed will look.
- Owner login is one password checked against an argon2id hash from env,
  granting an HttpOnly, Secure, SameSite=Lax signed cookie. Rate limited (§8).
- Media is served from `/media/:id/:variant` with immutable cache headers,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, and only
  allowlisted mime types (§6). Uploads arrive at `PUT /api/upload/:token`, which
  is token-authed and session-exempt.
- Per-token rate limits on `/mcp` and on uploads (§8).

## The dashboard shell (`routes/`)

| Route                  | Serves                                                    |
| ---------------------- | --------------------------------------------------------- |
| `GET /`                | The shell, every project's updates in one timeline.       |
| `GET /projects/[slug]` | The same shell, scoped to one project. Unknown slug: 404. |

Both loads are `routes/dashboard.ts`, which calls the same `readFullSnapshot`
that `GET /api/snapshot` serves — so the server render and the post-`resync`
refetch cannot drift apart — and reads the stream cursor _before_ the state, for
the reason given in `stream/snapshot.ts`. The page hands that snapshot to
`$web/Shell.svelte`, which adopts it and then goes live from that cursor.

That snapshot also carries `agentNames`: every agent id this deployment knows
mapped to its display name, revoked and long-offline agents included. Presence
cannot supply it — a timeline is mostly the work of agents that have gone — and a
card falling back to an id shows nothing useful, because every ULID begins `01`
until 2039. Names ride with the updates they annotate, so a `resync` repairs them
with everything else; an agent that appears _after_ the page loaded is named by
the rail's presence read instead.

## The owner's write endpoints (`owner/`)

`src/http/owner/` holds the handlers; the route files under `routes/api/` are
thin mounts over them, so validation, error mapping and the event each write
publishes are all tested without a server. Public entry point:
`src/http/owner/index.ts`.

| Route                             | Serves                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `POST /api/projects`              | Create a project. Idempotent on slug, like `create_project`.                    |
| `PATCH /api/projects/[reference]` | Rename, re-describe, pin, archive or unarchive. `reference` is a slug or an id. |
| `PATCH /api/updates/[id]`         | Pin or unpin one update. Nothing else about an update is editable.              |
| `DELETE /api/updates/[id]`        | Soft delete one update (§3).                                                    |

All four require the owner's session and answer `401 {"error":"unauthenticated"}`
without it, checked in the handler as well as in the hook because these are the
only endpoints that can destroy anything. A refusal carries the domain's own code
(`invalid_argument`, `not_found`, `conflict`) as `400`, `404`, `409`, so the
browser branches on one vocabulary whichever front door answered.

Every success publishes exactly one event, because the domain publishes it — so a
second open tab follows a rename, a pin, an archive or a delete over
`GET /api/stream` with nothing to poll. `owner/live-sync.test.ts` is that claim as
a test: real domain, real bus, real snapshot endpoint, two stores, one write.

The `SameSite=Lax` session cookie is what makes these safe from cross-site
forgery: a third-party page's request arrives with no session at all.

## Media (`media/`)

`src/http/media/` holds the two handlers; the route files are thin mounts over
them. Public entry point: `src/http/media/index.ts`.

| Route                       | Serves                                                        |
| --------------------------- | ------------------------------------------------------------- |
| `PUT /api/upload/[token]`   | An agent's raw bytes, against a single-use signed token (§6). |
| `GET /media/[id]/[variant]` | The stored file, immutable and inline. Unknown anything: 404. |

The upload route is **exempt from the session guard by name** in
`auth/guard.ts`: an agent has an upload token, not the owner's cookie. That makes
the token the whole authorisation, so every check lives in `$media` where the
bytes are, and this layer only translates refusals into statuses an agent can act
on — 403 for a spent or expired token, 413 for a body past the cap, 415 for bytes
that are not the declared type. A 400 for all three would leave an agent retrying
blind. There is a per-token rate limit (§8), keyed on the token id from the URL
and applied before the signature is checked, so a client looping on one token
cannot spend this server's time on HMACs and SQLite.

Serving requires the owner's session, checked here as well as in the hook. The
headers are the security and are asserted in `media/serve.test.ts`:
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline`,
`Cache-Control: public, max-age=31536000, immutable` with an `ETag` from the
sha256, `Content-Security-Policy: default-src 'none'; sandbox`, and
`Accept-Ranges: none` — honest, because range requests are not implemented. Only
the seven allowlisted types are ever emitted, and the id and variant are both
closed sets, so no string from a URL reaches a path. The raw upload directory
lives outside the served tree entirely.

Behind a reverse proxy the upload route needs a body limit as large as
`MAX_VIDEO_BYTES` and a generous read timeout, or the proxy refuses the upload
before this server sees it. The snippet is in a comment at the route itself.

## The live transport (`stream/`)

`src/http/stream/` holds the protocol; `routes/api/stream/` and
`routes/api/snapshot/` are thin mounts over it, so reconnect behaviour is tested
without a server. Public entry point: `src/http/stream/index.ts`.

| Route                       | Serves                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/stream`           | One SSE connection carrying every event type. `id:` is the global event seq. |
| `GET /api/snapshot`         | Projects plus the newest timeline page, stamped with the seq it is good to.  |
| `GET /api/snapshot/updates` | The timeline alone, for paging (`?cursor=`) or a scoped refetch.             |
| `GET /api/snapshot/agents`  | Who is online right now, derived from heartbeats. No query, no pages.        |

`/api/snapshot/agents` is the right rail's own read. Presence is derived and
never stored (§4), so it takes no filter and no cursor: the answer is whoever has
beaten within the window at the instant of the read. It is a separate route from
`/api/snapshot` because the rail re-reads it often to keep heartbeat times fresh,
and must not drag the timeline along each time.

All of them require the owner's session. The hook in `src/hooks.server.ts` already
refuses an unauthenticated `/api/...` request; each handler checks again for
itself, because one stream connection carries everything happening in the
deployment.

How a client stays correct:

1. Connect to `/api/stream`, then fetch `/api/snapshot`. Apply the snapshot and
   discard any frame whose `id:` is at or below the snapshot's `seq`.
2. On a drop, `EventSource` reconnects with `Last-Event-ID` on its own. The
   server replays exactly the missed events out of the ring buffer.
3. If the gap is wider than the buffer (500 events — a long sleep, or a server
   restart, which makes the cursor look _ahead_), the server sends one `resync`
   event and keeps the connection open. Refetch the snapshot and carry on.
4. Comment frames (`: heartbeat …`) go out every 15s so an idle connection is
   never mistaken for a dead one. Clients ignore them.

Disconnecting — the request aborting or the browser cancelling the body — drops
the bus subscription and the heartbeat timer. `stream.test.ts` asserts
`bus.listenerCount` is back to zero on both paths, because a leak here is
invisible until the process is holding thousands of dead subscribers.
