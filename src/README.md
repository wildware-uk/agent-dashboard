# `src/` layout

One directory per module in the design's module table
(`docs/superpowers/specs/2026-08-25-agent-dashboard-design.md` §2). Each has a
README stating its one job and the only modules it may import.

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

| Module        | Alias     | Job                                                    | May import                          |
| ------------- | --------- | ------------------------------------------------------ | ----------------------------------- |
| `src/db/`     | `$db`     | SQLite connection, migrations, repositories            | —                                   |
| `src/events/` | `$events` | Typed in-process pub/sub + SSE ring buffer             | —                                   |
| `src/media/`  | `$media`  | Upload tokens, ingest, derivatives, disk layout        | `$db`, `$events`                    |
| `src/domain/` | `$domain` | All business rules                                     | `$db`, `$events`, `$media`          |
| `src/mcp/`    | `$mcp`    | MCP Streamable HTTP tool surface                       | `$domain`                           |
| `src/http/`   | `$http`   | SvelteKit routes: REST, SSE, `/mcp` mount, media, auth | `$domain`, `$mcp`, `$media`, `$web` |
| `src/web/`    | `$web`    | Svelte components and client stores                    | HTTP API only                       |

`src/config.ts` (`$config`) is a leaf: env parsing with no dependencies, so
anything may import it.

The rule that keeps this honest: **adapters never touch the database, and the
domain never imports an adapter type.** `src/architecture.test.ts` enforces the
table above, so a boundary violation fails `npm test` rather than review.

One edge is wider here than in the design table: `$http` may import `$web`,
because `src/http/routes/` is the SvelteKit route tree and a route has to render
the components that live in `src/web/`. The arrow only points that way — `$web`
importing `$http` is still a failure.

## Where SvelteKit's own directories went

SvelteKit is configured (in `vite.config.ts`) with `files.routes = src/http/routes`
and `files.lib = src/web`. So:

- routes live in `src/http/routes/`, not `src/routes/`
- `$lib` and `$web` both resolve to `src/web/`

That is deliberate: `src/http/` is described in the design as "SvelteKit routes",
and pointing the framework at the module means there is no second, parallel
directory tree to keep in sync.
