# Agent Dashboard

A self-hosted dashboard where AI coding agents report what they are doing, and
you watch and steer in real time.

Agents connect over **MCP** (remote Streamable HTTP — no local install) to create
projects, post status updates with images and video, claim tasks, read your
replies, and block on your approval. You watch a live feed in the browser that
updates without a refresh.

> **Status:** in development. Design is complete and committed; implementation is
> tracked in [issues](../../issues).

## What it does

- **Rich status updates** — markdown, images, and video, posted by agents as they work.
- **Projects** — agents create them; you rename, pin, and archive them.
- **Live** — everything streams to an open browser over SSE, no polling, no reload.
- **Presence** — see which agents are alive right now.
- **Control plane** — assign tasks to agents, reply to them, and gate their work
  behind an approval you click.

## Scope

Single-owner and self-hosted. One deployment, one owner, no multi-tenancy or user
accounts. Sized for tens of agents and low thousands of updates on one box.

## Design

See [`docs/superpowers/specs/2026-08-25-agent-dashboard-design.md`](docs/superpowers/specs/2026-08-25-agent-dashboard-design.md)
for the full architecture, data model, MCP tool surface, and approval-gate semantics.

## Development

Requires Node 22+ and `ffmpeg` on `PATH`.

```sh
npm ci
cp .env.example .env   # then fill in the secrets
npm run dev
```

| Script                   | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `npm run dev`            | Vite dev server                                                 |
| `npm run build`          | Production build via the Node adapter (`build/index.js`)        |
| `npm test`               | Node unit tests (Vitest) — the default suite, no browser needed |
| `npm run test:component` | Svelte component tests in a real Chromium (Vitest browser mode) |
| `npm run test:e2e`       | Playwright end-to-end tests                                     |
| `npm run test:all`       | Unit + component + e2e                                          |
| `npm run typecheck`      | `svelte-check` against `tsconfig.json` (TypeScript strict)      |
| `npm run lint`           | Prettier check + ESLint                                         |
| `npm run format`         | Prettier write                                                  |

Component and e2e tests download a Chromium build on first run, so CI and the
default `npm test` deliberately stay on the node-only unit suite.

### Layout

`src/` mirrors the module table in §2 of the design. Each directory has a README
stating its one job and the only modules it is allowed to import.

```
src/db/       SQLite connection, migrations, repositories
src/events/   typed in-process pub/sub + SSE ring buffer
src/media/    upload tokens, ingest, derivatives, disk layout
src/domain/   all business rules
src/mcp/      MCP Streamable HTTP tool surface
src/http/     SvelteKit routes (browser REST, SSE, /mcp mount, media, auth)
src/web/      Svelte components and client stores
```

SvelteKit is pointed at `src/http/routes` for routes and `src/web` for `$lib`, so
the framework's own directories line up with the module boundaries instead of
fighting them. Import across modules through the `$db`, `$events`, `$media`,
`$domain`, `$mcp`, `$http` and `$web` aliases.

## Configuration

Every setting is an environment variable. See [`.env.example`](.env.example) for
the full list with defaults and how to generate each secret. `src/config.ts`
validates them at boot, so a bad value fails with the offending variable named
rather than at the first request.

Back up `DATA_DIR`: the SQLite database plus an rsync of `media/`. The design's
`sqlite3 .backup` guidance needs the `sqlite3` CLI, which is a separate package
from the `better-sqlite3` library this app uses — the packaging slice must put it
in the Docker image, or take the online backup through `better-sqlite3`'s own
`db.backup()` instead.

## Deployment

The app is a single Node process. `npm run build` then `node build`, listening on
`PORT` (default **8010**).

Put a reverse proxy in front for TLS. Two things about that proxy are not optional.

### The live feed must not be buffered

The dashboard streams over Server-Sent Events at `/api/stream`. A buffering proxy
breaks this in the most confusing way available: the page connects, reports no
error, and simply never updates. Caddy detects `text/event-stream` on its own, but
say it explicitly so a later config change cannot regress it.

```caddy
agents.wildware.dev {
	@stream path /api/stream
	reverse_proxy @stream 127.0.0.1:8010 {
		flush_interval -1
	}

	# Wide enough for slow video uploads and the 55s approval-gate holds.
	reverse_proxy 127.0.0.1:8010 {
		transport http {
			read_timeout 300s
		}
	}
}
```

Behind nginx the equivalent is `proxy_buffering off` on that route, plus
`proxy_read_timeout 300s`:

```nginx
location /api/stream {
	proxy_pass http://127.0.0.1:8010;
	proxy_buffering off;
	proxy_cache off;
	proxy_read_timeout 300s;
	proxy_set_header Connection '';
	proxy_http_version 1.1;
}
```

### The client address must be forwarded

Set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` (see `.env.example`).
Without them the Node adapter reports the _proxy_ as every request's client, so
the login rate limiter collapses into one shared bucket and five wrong guesses
from any stranger lock the owner out for fifteen minutes. The app refuses to start
in this state rather than serving a dashboard you can be locked out of.

Also set `PUBLIC_BASE_URL` to the externally reachable origin. `create_upload`
hands agents an absolute upload URL built from it, and an agent given a
`127.0.0.1` URL cannot upload anything.

### Backups

Two things to keep: the SQLite file and `data/media/`. Take the database copy
through SQLite's online backup rather than copying the file while the process
writes to it — WAL mode means a plain `cp` can capture a torn state. The `sqlite3`
CLI is not required and is not assumed to be installed.

## Licence

MIT
