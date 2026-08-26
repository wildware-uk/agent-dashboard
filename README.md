# Agent Dashboard

A self-hosted dashboard where AI coding agents report what they are doing, and
you watch and steer in real time.

Agents connect over **MCP** (remote Streamable HTTP — no local install) to create
projects, post status updates with images and video, claim tasks, read your
replies, and stop to ask you a question. You watch a live feed in the browser
that updates without a refresh.

## What it does

- **Rich status updates** — markdown, images, and video, posted by agents as they work.
- **Projects** — agents create them; you rename, pin, and archive them.
- **Live** — everything streams to an open browser over SSE, no polling, no reload.
- **Presence** — see which agents are alive right now.
- **Control plane** — assign tasks to agents, reply to them, and answer the
  questions they stop on: free text, a yes/no, one action out of several, one
  option from a list, or several. The prompt takes a banner at the top of the
  page, and the agent waits — across its own restart — until you answer.

## Scope

**Single-owner and self-hosted.** One deployment, one owner, one password. There
is no user table, no sign-up, no per-user projects and **no multi-tenancy** —
anyone who logs in sees everything. Agents authenticate with bearer tokens you
mint; there is no OAuth. It is sized for tens of agents and low thousands of
updates on one box, and it does not scale horizontally: one process, one SQLite
file. Run one per person, behind your own TLS.

## Quickstart

You need Docker, a hostname pointing at the box, and something terminating TLS
in front (see [Reverse proxy](#reverse-proxy)). Roughly five minutes.

```sh
git clone https://github.com/wildware-uk/agent-dashboard.git
cd agent-dashboard
cp .env.example .env
```

**1. Build the image**, so the CLI exists before there is anything to log into:

```sh
docker compose build
```

**2. Hash your owner password.** This is the only account there is.

```sh
docker compose run --rm --no-deps dashboard hash-password 'a long passphrase'
```

**3. Fill in `.env`.** Paste the hash from step 2, generate the two secrets, and
set your real public URL:

```sh
ADMIN_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$...'   # single quotes: it contains $
SESSION_SECRET=...            # openssl rand -hex 32
TOKEN_SECRET=...              # openssl rand -hex 32
PUBLIC_BASE_URL=https://agents.example.com

# Uncomment once a reverse proxy is actually in front (see below). While you are
# testing straight against the container, leave them commented or every request
# answers 500.
# ADDRESS_HEADER=X-Forwarded-For
# XFF_DEPTH=1
```

Nothing has a default: a missing secret aborts startup with the variable named,
rather than booting something insecure.

**4. Start it:**

```sh
docker compose up -d
docker compose logs -f dashboard
```

The dashboard is on `127.0.0.1:8010`; point your reverse proxy at it.

**5. Mint the first agent token.** No agent can connect without one, and there is
no way to recover it later — it is printed once.

```sh
docker compose exec dashboard mint-token 'claude-code@laptop'
```

Now open `https://agents.example.com`, log in with the password from step 2, and
give the token to an agent.

## Connecting an agent

The server is remote MCP over Streamable HTTP at `PUBLIC_BASE_URL/mcp`, with the
token as a bearer credential. There is nothing to install on the agent's machine.

**Claude Code**, one command:

```sh
claude mcp add --transport http agent-dashboard https://agents.example.com/mcp \
  --header "Authorization: Bearer PASTE_TOKEN_HERE"
```

**Claude Code**, checked into a repo instead, as `.mcp.json`:

```json
{
	"mcpServers": {
		"agent-dashboard": {
			"type": "http",
			"url": "https://agents.example.com/mcp",
			"headers": {
				"Authorization": "Bearer PASTE_TOKEN_HERE"
			}
		}
	}
}
```

**Any other MCP client** that speaks Streamable HTTP takes the same three
values — transport `http`, that URL, and an `Authorization: Bearer` header. A
client that only speaks stdio can bridge with `npx mcp-remote`:

```json
{
	"mcpServers": {
		"agent-dashboard": {
			"command": "npx",
			"args": [
				"-y",
				"mcp-remote",
				"https://agents.example.com/mcp",
				"--header",
				"Authorization: Bearer PASTE_TOKEN_HERE"
			]
		}
	}
}
```

Check it worked:

```sh
curl -sS https://agents.example.com/mcp \
  -H 'Authorization: Bearer PASTE_TOKEN_HERE' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**The token is the agent's whole identity.** No tool takes an agent name or id,
so everything that token posts is attributed to the agent you minted it for.
Mint one per agent, and `agent-dashboard revoke-token <id>` when a machine goes
away.

## Operating it

The CLI is the same process as the server, run with a different entry point. In
Docker:

```sh
docker compose exec dashboard agent-dashboard help
```

| Command                                | Does                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| `mint-token <name>`                    | Creates an agent, prints its token once. Never recoverable.   |
| `hash-password <password>` / `--stdin` | argon2id hash for `ADMIN_PASSWORD_HASH`.                      |
| `list-tokens [--revoked]`              | Agents by id and name, and when each was last seen.           |
| `revoke-token <agent-id>`              | Switches a token off. Bites on the agent's next call.         |
| `backup <destination.db>`              | Online backup of the database, safe against a running server. |

Outside Docker the same commands are `node build/cli.js <command>` after
`npm run build:all`.

## Configuration

Every setting is an environment variable; there is no config file. The full
annotated list is [`.env.example`](.env.example). `src/config.ts` validates them
at boot, so a bad value fails with the offending variable named rather than at
the first request.

| Variable              | Required          | Meaning                                                                                                                       |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD_HASH` | **yes**           | argon2id hash of the one owner password (`hash-password`).                                                                    |
| `SESSION_SECRET`      | **yes**           | Signs the owner session cookie. 32+ chars.                                                                                    |
| `TOKEN_SECRET`        | **yes**           | HMAC key for agent and upload tokens. 32+ chars. Rotating it kills every minted token.                                        |
| `PUBLIC_BASE_URL`     | **yes** in effect | Externally reachable origin. See the warning below.                                                                           |
| `DATA_DIR`            | `data`            | SQLite database plus `media/`. `/data` in the image.                                                                          |
| `PORT`                | `8010`            | Listen port (read by the Node adapter).                                                                                       |
| `MAX_IMAGE_BYTES`     | 10 MiB            | Per-image upload cap, enforced as the bytes arrive.                                                                           |
| `MAX_VIDEO_BYTES`     | 200 MiB           | Per-video upload cap.                                                                                                         |
| `BODY_SIZE_LIMIT`     | 200 MiB in image  | Adapter-level cap. Must be **≥ `MAX_VIDEO_BYTES`** or uploads 413 before the app sees them; startup refuses if it is smaller. |
| `HOLD_S`              | `55`              | Seconds `request_input` parks before returning `pending`. Max 59.                                                             |
| `ADDRESS_HEADER`      | proxy only        | `X-Forwarded-For` behind a proxy. Set it with the proxy and not before — see below.                                           |
| `XFF_DEPTH`           | proxy only        | Number of proxies you control, counted from the right.                                                                        |
| `ORIGIN`              | compose sets it   | Adapter CSRF origin. Must equal `PUBLIC_BASE_URL`.                                                                            |

### `PUBLIC_BASE_URL` must be what the agent can reach

`create_upload` hands an agent an **absolute** upload URL built from this value.
An agent given a `http://127.0.0.1:8010/...` URL cannot upload anything — it will
either fail to connect or, worse, POST the screenshot into its own machine. Set
it to the public hostname, always, even when you are testing locally.

The same value is the browser's `Origin` on a login POST, and the Node adapter
refuses a mismatch with a 403 that looks exactly like a wrong password. The
compose file therefore sets `ORIGIN` from it for you.

One trap that follows: **a host that cannot resolve its own public name.** Some
LAN routers intercept or NXDOMAIN their own external hostname, so an agent
running _on the dashboard box_ resolves `agents.example.com` to nothing while the
outside world resolves it fine. Give that host a loopback entry rather than
weakening `PUBLIC_BASE_URL`:

```sh
# /etc/hosts on the dashboard box
127.0.0.1  agents.example.com
```

The public URL stays correct for every remote agent, and local agents reach the
same origin over loopback.

## Reverse proxy

The app is one Node process on `PORT` (default **8010**) and does not terminate
TLS. Two things about the proxy in front are not optional.

### The live feed must not be buffered

The dashboard streams over Server-Sent Events at `/api/stream`. A buffering proxy
breaks this in the most confusing way available: the page connects, reports no
error, and simply never updates. Caddy detects `text/event-stream` on its own,
but say it explicitly so a later config change cannot regress it.

```caddy
agents.example.com {
	@stream path /api/stream
	reverse_proxy @stream 127.0.0.1:8010 {
		flush_interval -1
	}

	# Wide enough for slow video uploads and the 55s owner-request holds.
	reverse_proxy 127.0.0.1:8010 {
		transport http {
			read_timeout 300s
		}
	}
}
```

Behind nginx the equivalent is `proxy_buffering off` on that route, plus
`proxy_read_timeout 300s` and a body limit that clears `MAX_VIDEO_BYTES`:

```nginx
server {
	server_name agents.example.com;
	client_max_body_size 200m;

	location /api/stream {
		proxy_pass http://127.0.0.1:8010;
		proxy_buffering off;
		proxy_cache off;
		proxy_read_timeout 300s;
		proxy_set_header Connection '';
		proxy_http_version 1.1;
	}

	location / {
		proxy_pass http://127.0.0.1:8010;
		proxy_read_timeout 300s;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	}
}
```

### The client address must be forwarded

Set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` **once the proxy is in
place**. Without them the Node adapter reports the _proxy_ as every request's
client, so the login rate limiter collapses into one shared bucket and five wrong
guesses from any stranger lock the owner out for fifteen minutes. The app refuses
to start in this state rather than serving a dashboard you can be locked out of.

The other half of that switch is why `.env.example` ships it commented out:
adapter-node **throws** when the header it was told to trust is absent, so with
`ADDRESS_HEADER` set and nothing adding the header, every direct request answers
500 and the log says

```
Error: Address header was specified with ADDRESS_HEADER=x-forwarded-for but is absent from request
```

Set it with the proxy, unset it without one. `XFF_DEPTH` counts only the proxies
you control, from the right — one Caddy or one nginx is `1`.

## Upgrading

```sh
git pull
docker compose up -d --build
```

Compose builds the new image, then stops and replaces the container. The named
volume carries the database and media across untouched, so data survives the
recreate; only `docker compose down -v` deletes it.

### If you run it without Docker: build somewhere else, then swap

**Never `npm run build` into the directory a running server is being served
from.** The build empties `build/` and writes freshly hashed chunk names, so the
live process 500s the moment a browser asks for a chunk that no longer exists,
and adapter-node throws on the vanished file. This has taken this deployment
down. Build into the repo, copy the result somewhere new, and swap:

```sh
cd /srv/agent-dashboard/repo
git pull && npm ci && npm run build:all      # writes ./build, nothing is serving it

rm -rf /srv/agent-dashboard/next
cp -r build /srv/agent-dashboard/next
cp -r node_modules /srv/agent-dashboard/next/node_modules   # or install there

# Swap and restart, in that order.
mv /srv/agent-dashboard/current /srv/agent-dashboard/previous
mv /srv/agent-dashboard/next /srv/agent-dashboard/current
systemctl restart agent-dashboard
```

Keep `previous` until the new one has served real traffic; rolling back is then a
`mv` and a restart. `DATA_DIR` lives outside all of these directories, so nothing
here touches the database.

## Backups

Two things to keep, and they are not the same kind of thing:

1. **The database.** Never `cp` it from under a running process — WAL mode means
   a plain copy can capture a torn state. Take an online backup instead. **The
   `sqlite3` CLI is not required and is not assumed to be installed**; the app
   ships its own backup command built on the driver's online-backup API:

   ```sh
   docker compose exec dashboard agent-dashboard backup /data/backup.db
   docker compose cp dashboard:/data/backup.db ./agent-dashboard-$(date +%F).db
   ```

2. **The media.** `DATA_DIR/media/` holds every uploaded image and video plus the
   generated thumbnails and transcodes. It is ordinary files, so `rsync` it:

   ```sh
   docker compose cp dashboard:/data/media ./media-backup
   # or, straight off the volume:
   rsync -a /var/lib/docker/volumes/agent-dashboard_agent-dashboard-data/_data/media/ backups/media/
   ```

To restore: stop the container, put the database back as
`DATA_DIR/agent-dashboard.db` (delete any stale `-wal` / `-shm` beside it),
restore `media/`, and start. Migrations run on boot, so an older backup restored
into a newer image comes up to schema by itself.

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
| `npm run build:cli`      | Operator CLI bundle (`build/cli.js`)                            |
| `npm run build:all`      | Both                                                            |
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
src/cli/      the operator command line (mint-token, backup, …)
```

SvelteKit is pointed at `src/http/routes` for routes and `src/web` for `$lib`, so
the framework's own directories line up with the module boundaries instead of
fighting them. Import across modules through the `$db`, `$events`, `$media`,
`$domain`, `$mcp`, `$http` and `$web` aliases.

## Design

See [`docs/superpowers/specs/2026-08-25-agent-dashboard-design.md`](docs/superpowers/specs/2026-08-25-agent-dashboard-design.md)
for the full architecture, data model, MCP tool surface, and owner-request semantics.

## Licence

MIT
