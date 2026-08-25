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
  allowlisted mime types (§6).
- Per-token rate limits on `/mcp` and on uploads (§8).

## The live transport (`stream/`)

`src/http/stream/` holds the protocol; `routes/api/stream/` and
`routes/api/snapshot/` are thin mounts over it, so reconnect behaviour is tested
without a server. Public entry point: `src/http/stream/index.ts`.

| Route                       | Serves                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/stream`           | One SSE connection carrying every event type. `id:` is the global event seq. |
| `GET /api/snapshot`         | Projects plus the newest timeline page, stamped with the seq it is good to.  |
| `GET /api/snapshot/updates` | The timeline alone, for paging (`?cursor=`) or a scoped refetch.             |

All three require the owner's session. The hook in `src/hooks.server.ts` already
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
