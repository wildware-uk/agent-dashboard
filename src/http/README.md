# `src/http` — the browser-facing adapter

**One job:** the SvelteKit routes. Browser REST, the SSE stream, the `/mcp`
mount, media serving, and owner auth.

**May import:** `$domain`, `$mcp`, `$media`, `$config`, and `$web` — a route has
to render the components that live there. The design table omits that last edge
because it does not separate "routes" from "components"; the arrow only points
this way, and `$web` importing `$http` remains a failure.

**Must not:** touch the database or the event bus directly, and must not hold
business rules. A route validates, calls domain, and serialises.

**`src/http/routes/` is the SvelteKit route tree.** `vite.config.ts` sets
`files.routes` to it, so there is no `src/routes/`.

Notes carried from the design:

- `GET /api/stream` is the single SSE endpoint. On reconnect it honours
  `Last-Event-ID` from the events ring buffer, or emits `resync` (§4).
- Behind nginx the stream route needs `proxy_buffering off`, or SSE dies
  silently (§4).
- Owner login is one password checked against an argon2id hash from env,
  granting an HttpOnly, Secure, SameSite=Lax signed cookie. Rate limited (§8).
- Media is served from `/media/:id/:variant` with immutable cache headers,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, and only
  allowlisted mime types (§6).
- Per-token rate limits on `/mcp` and on uploads (§8).
