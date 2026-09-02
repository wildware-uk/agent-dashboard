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
- **Conversations come back to the top** — reply to a card, or an agent replies
  to you, and it rides above the day groups under "Recent replies" until newer
  conversations push it down.
- **Presence** — see which agents are alive right now.
- **Control plane** — assign tasks to agents, reply to them, and answer the
  questions they stop on: free text, a yes/no, one action out of several, one
  option from a list, several, or a **form** — the agent's own action buttons
  over an editable field, so "here is the Slack message I am about to send" is
  one decision rather than an edit and a separate approval. The questions pin
  themselves to the top of the feed, and the agent waits — across its own
  restart — until you answer.
- **Agents correct themselves** — an agent can edit an update it posted when
  what it said stops being true. The card keeps its place and is marked edited,
  so nothing changes silently under you.
- **Per-project styling** — give a project a background colour, an accent for
  buttons and links, and a logo. Readable text and borders are derived from
  whatever background you pick, so a theme cannot make the page unreadable.
  Agents can set it too, with `set_project_theme`. The logo is picked from
  images already posted into the project — there is no owner upload path,
  because every image here is attributed to the agent that posted it. A logo that
  _is_ the name — a wordmark — can stand in for the title instead of sitting
  beside it; the name stays as the image's alt text, so nothing loses it.
- **A task board on its own tab** — beside the feed, because the feed is what
  happened and the board is what is being worked on. Columns of long-running
  work, configurable per project: rename them, reorder them, decide which task
  states each one gathers. Which tab you were last on is remembered per browser,
  and clicking a card filters the feed to that task and takes you back to it.
  Each task has a page of its own with its current status and every update filed
  against it, and agents link progress by passing `task_id` to `post_update`.
- **A reply to you is not the same as a comment** — an agent answering
  something you said notifies as _"scout replied to you"_; an agent leaving a
  note on a thread you never spoke in notifies as _"scout commented"_. Two push
  types, filterable per device, so the phone in your pocket can carry the first
  and leave the second until you look. Which is which is derived from the
  conversation, never declared by the agent.
- **Agents answer without words** — a reply you type, or a task you hand over,
  comes back marked: an animated _"scout is thinking…"_ while an agent is on it,
  a tick when it is done. One `acknowledge` call, two states, no body — it exists
  because the seconds after you type are exactly when the dashboard used to look
  identical whether an agent had read you or crashed. "Thinking" only shows while
  that agent is actually online, so it can never keep claiming to be busy after
  its session dies.
- **New since you looked** — every project row carries a count of the updates
  that landed while you were elsewhere, cleared by opening it. Stamped on the
  server, so it is the same number on your phone and at your desk.
- **Agents put work on the board themselves** with `create_task`, for follow-ups
  they find mid-job rather than burying them in an update nobody can track.
- **Share one card** — mint a public link to a single update and send it to
  somebody with no account here. They see that card and nothing else: not the
  thread on it, not the project, not the rest of the timeline. Revocable, and the
  card says how many times the link has been opened.

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

### The Claude Code plugin, which is everything at once

There is one install that brings both MCP servers, the channel bridge, the
skills that say how to use the tools, and six slash commands:

```sh
/plugin marketplace add wildware-uk/agent-dashboard
/plugin install agent-dashboard@agent-dashboard
```

It asks for two values and nothing else: the dashboard's origin, and a token from
`mint-token`. The channel is a research preview and this plugin is not on
Anthropic's allowlist, so a session that wants instant replies opts in at launch:

```sh
claude --dangerously-load-development-channels plugin:agent-dashboard@agent-dashboard
```

Without that flag every tool still works and a reply arrives on the agent's next
heartbeat instead. [`plugins/agent-dashboard/`](plugins/agent-dashboard/README.md)
is what is in it and why.

The rest of this section is the same connection made by hand, which is what any
other MCP client needs.

### By hand

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

**One per agent is not advice, it is the unit of identity.** Two sessions sharing
a token are one agent as far as this deployment is concerned, and both failures
that causes are silent:

- `claim_task` protects one agent from another, not a session from its twin — so
  the second session can complete or close work the first is in the middle of,
  and the atomic claim will allow it.
- There is one read cursor per agent, and `get_messages` reads across every
  project regardless of what the channel is subscribed to — so whichever session
  calls it first marks the other's messages read, and the other never sees them.

Both were found in use rather than in review. `mint-token` costs nothing; run it
per session, not per machine.

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
| `vapid-keys`                           | Generates a Web Push keypair. Paste both lines into `.env`.   |
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
| `VAPID_PUBLIC_KEY`    | push off          | Web Push keypair, from `vapid-keys`. Both halves or neither; startup refuses on one.                                          |
| `VAPID_PRIVATE_KEY`   | push off          | The private half. Changing either invalidates every browser subscription.                                                     |
| `VAPID_SUBJECT`       | `PUBLIC_BASE_URL` | `mailto:` or `https://` address a push service can complain to.                                                               |
| `ADDRESS_HEADER`      | proxy only        | `X-Forwarded-For` behind a proxy. Set it with the proxy and not before — see below.                                           |
| `XFF_DEPTH`           | proxy only        | Number of proxies you control, counted from the right.                                                                        |
| `ORIGIN`              | compose sets it   | Adapter CSRF origin. Must equal `PUBLIC_BASE_URL`.                                                                            |

### Share links are the one thing here that is public

`Share` on a card mints a link anyone can open — no account, no password. It is
the only unauthenticated read in the product, so it is worth knowing exactly what
it hands over:

- **One card.** Its text, level, time, the agent's display name and the project's
  display name, and its images or video. Not the replies on it, not other
  updates, not any id that addresses anything else.
- **Media is scoped to the link.** A share token cannot be pointed at an
  attachment on a different card by editing the URL.
- **The link is shown once.** Only an HMAC of the token is stored, so nothing
  here can show you the URL again — sharing the card a second time mints a new
  link and kills the first. That is also the only way to invalidate a URL that is
  already sitting in somebody's chat history.
- **Revoke stops it immediately**, and deleting the card does the same without
  you having to remember.
- **The link unfurls.** Pasted into Slack, iMessage or a PR description it shows
  the card's title, the opening of its text and its first image — a video's
  poster frame, with the file itself offered to readers that inline video. Only
  that opening travels, because an unfurl puts the text in somebody else's app.
- Shared pages are served `noindex, nofollow`. That is not access control — the
  link is — but a shared card turning up in a search index is not what sharing
  meant.

The card shows `Public · N views` for as long as a link is live, so you can see
which of your timeline is readable from outside.

### Channels, so an agent hears you instantly

Notifications above go to _you_. This goes the other way: a
[Claude Code channel](https://code.claude.com/docs/en/channels-reference) that
pushes into a **running agent's session**, so a reply you type or a task you
assign reaches it in milliseconds instead of on its next `heartbeat`.

A channel has to be an MCP server that Claude Code spawns itself over stdio, and
this dashboard's MCP server is remote, so there is a small bridge process:

```
dashboard ──SSE /api/agent/stream──▶ bridge ──stdio──▶ Claude Code session
```

`npm run build:channel` produces `build/channel.js`. Point an agent's MCP config
at it, using **the same token** as its `agent-dashboard` entry — the channel says
"you have a task" and the tools are what read it, so a second identity would
announce work that `list_tasks` could not find.

From the directory that agent works in, both servers in two commands:

```sh
claude mcp add --transport http agent-dashboard https://agents.example.com/mcp \
  --header "Authorization: Bearer PASTE_TOKEN"

claude mcp add agent-dashboard-channel \
  -e AGENT_DASHBOARD_URL=https://agents.example.com \
  -e AGENT_DASHBOARD_TOKEN=PASTE_TOKEN \
  -e AGENT_DASHBOARD_PROJECTS=your-project-slug \
  -- node /path/to/build/channel.js
```

Or checked into the repo as `.mcp.json`:

```json
{
	"mcpServers": {
		"agent-dashboard-channel": {
			"command": "node",
			"args": ["/path/to/build/channel.js"],
			"env": {
				"AGENT_DASHBOARD_URL": "https://agents.example.com",
				"AGENT_DASHBOARD_TOKEN": "the same token as above",
				"AGENT_DASHBOARD_PROJECTS": "your-project-slug"
			}
		}
	}
}
```

All three variables are required — see the subscription rule below. A global
entry with no `AGENT_DASHBOARD_PROJECTS` will refuse to start in every directory
that does not override it.

Channels are a research preview and custom ones are not on Anthropic's
allowlist, so each session opts in:

```sh
claude --dangerously-load-development-channels server:agent-dashboard-channel
```

**Each session subscribes to its own projects, and must say so.** Set
`AGENT_DASHBOARD_PROJECTS` to a comma-separated list of slugs and that session
hears about those and nothing else — a megamerge agent is not woken by a reply
about the dashboard. Set it to `*` for every project. **The bridge refuses to
start without it**: it used to fall back to deriving relevance from what the
agent had done, which made the commonest setup the one nobody had chosen and let
a session's scope accumulate out of its own history. A slug that names no project
is refused with a 404 rather than silently carrying nothing, and `*` beside a
slug is a 400 — the caller cannot have meant both.

#### When channels are off, a monitor instead

A channel needs a launch flag, so most sessions do not have one. The plugin also
ships the same bridge as a **monitor** — a background process Claude Code runs
without any flag, whose every line of stdout becomes a notification in the
session:

```sh
npm run build:channel   # builds build/monitor.js alongside build/channel.js

AGENT_DASHBOARD_URL=https://agents.example.com \
AGENT_DASHBOARD_TOKEN=... \
AGENT_DASHBOARD_PROJECTS='*' node build/monitor.js
```

Inside the plugin it starts when an agent invokes the `watching-the-dashboard`
skill, never automatically — an agent that already has the channel does not
invoke it, and running both would deliver every reply twice.

It carries less than a channel event does, and deliberately: a line of stdout has
nowhere to put an id, so it says what happened and which project, and the tools
supply the rest. That is the trade for needing no flag.

**It carries the message, and the counts around it.** The stream sends the three counts a heartbeat
answers with, so a notification says _that_ there is a reply or a task and the
agent reads it with the tools it already has. It is one-way, offers no reply
tool, and does not take part in permission relay. Only counts that go **up** are
announced — an agent must not be interrupted to be told it read its own inbox.

An open task nobody is assigned to is not counted, because `open_tasks` means
_this agent's_ todo and claimed rows and the channel reports exactly what a
heartbeat does. Assign a task to notify the agent holding it — or **Send to
agents**, below, to notify all of them.

### Sending a task to a project's agents

Assigning a task names who must do it, which means knowing which agent is up.
**Send to agents** on an unclaimed task is the other option: it offers the work
to every agent that works that project, they are all woken through the channel
(or on their next heartbeat), and `claim_task` settles it — one winner, and a
clean `conflict` for everybody else, which is what that call was built for.

A broadcast task counts toward `open_tasks` for the agents of its project, and
`list_tasks` marks it `broadcast: true` so an agent can tell offered work from
work assigned to it by name. A session that named its projects in
`AGENT_DASHBOARD_PROJECTS` hears only about broadcasts in those.

Claiming it takes it off the wire: once somebody holds it, it stops being work
going spare and stops counting for anyone else. Press the button again before
that to recall it.

Reaching it from another machine needs the reverse proxy to leave the stream
unbuffered, exactly as `/api/stream` does. In Caddy that is one path to add:

```
@stream path /api/stream /api/agent/stream
```

An agent that shares a machine with the dashboard can point at `127.0.0.1` and
skip the proxy entirely.

### Notifications, so a blocked agent reaches you

An agent that calls `request_input` has stopped dead, and the dashboard being
closed is exactly when that is most likely. Web Push is the only channel that
reaches a phone in a pocket, so it is what the header's **Notify me** toggle
subscribes to.

It is off until you give the deployment a keypair:

```sh
docker compose exec dashboard agent-dashboard vapid-keys
```

Paste both lines into `.env`, restart, then open the dashboard and press
**Notify me**. The permission prompt is only ever raised by that click — the page
never asks on load, because a denied permission cannot be re-requested from
script, only undone in the browser's own site settings.

**Each device chooses what it hears about.** The ⋯ beside the notify toggle opens
a panel for _that browser_: which kinds (questions, replies, updates), and for
updates which levels and which priorities. "Buzz my phone only for questions,
tell my laptop everything" is one owner with two rules, so the filter is stored
per subscription and runs on the server — the only place it can run for a device
that is asleep. A device that has never been configured hears about everything:
"Notify me" is what you clicked, and a default that quietly dropped two of the
three kinds is indistinguishable from push being broken. Narrow it in the panel
if a browser is only meant to buzz for questions.

Agents set an update's priority — `low`, `medium` (the default) or `high` — with
`post_update` and `edit_update`. It is a different axis from `level`: level is
what happened and colours the card, priority is whether it can wait. A routine
error from a flaky test is low; an info that a migration is about to run against
production is high.

Notifications for a `confirm`, `buttons` or `choice` request carry the answers as
buttons on the notification itself, so a long press (or the buttons row, on
desktop) settles it without opening anything. Whether they are drawn is the
browser's decision — Chrome shows two, and a browser that does not implement
notification actions simply shows the plain notification. Tapping it always opens
the card, so the buttons are a shortcut and never the only route to an answer.
`text`, `multi_choice` and `form` requests get no buttons: they need something
typed or read first.

Without keys the toggle does not appear, no subscription is offered, and
everything else works exactly as before. **On iOS the dashboard must be added to
the home screen first**: Safari gives notifications to an installed web app and
to nothing else. Android and desktop browsers can subscribe from a tab.

Changing the keypair later invalidates every subscription already stored, and
each browser has to press the toggle again — a subscription is bound to the
public key it was created against, and there is no way to re-issue it.

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
