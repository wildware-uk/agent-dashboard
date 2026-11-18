# `plugins/agent-dashboard` — the whole client side, as one plugin

**One job:** everything an agent needs to use a deployment of this dashboard,
installed with one command and configured with two values.

Before this existed, connecting an agent meant a `claude mcp add` for the remote
server, a second hand-written `.mcp.json` entry pointing at a `build/channel.js`
somewhere on disk, and the knowledge of how to use seventeen tools living only in
their descriptions. The plugin is those three things packaged.

## What is in it

| Piece                           | Is                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.mcp.json` → `agent-dashboard` | The remote Streamable HTTP server at `<url>/mcp`, bearer-authenticated.                                                  |
| `.mcp.json` → `..._channel`     | The stdio bridge, so a reply reaches a running session in milliseconds.                                                  |
| `bin/channel.mjs`               | That bridge, built from `src/channel/` and **committed**. See below.                                                     |
| `skills/agent-dashboard`        | The run's shape: register, heartbeat, project, end.                                                                      |
| `skills/posting-updates`        | What is worth a card, level vs priority, media, corrections.                                                             |
| `skills/asking-the-owner`       | The six `request_input` kinds and the `await_request` wait loop.                                                         |
| `skills/marking-work`           | Marking a card as work, the five states, and what to say as you go.                                                      |
| `commands/`                     | `/dashboard-online`, `/dashboard-report`, `/dashboard-ask`, `/dashboard-work`, `/dashboard-offline`, `/dashboard-check`. |
| `hooks/hooks.json`              | One `SessionStart` line saying a human is watching, or how to configure.                                                 |

## Installing it

```sh
/plugin marketplace add wildware-uk/agent-dashboard
/plugin install agent-dashboard@agent-dashboard
```

It then asks for two values, which is the whole configuration:

| `userConfig`    | Is                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `dashboard_url` | The **origin** of your deployment. No trailing slash, no `/mcp` — both servers append what they need. |
| `agent_token`   | A token from `agent-dashboard mint-token <name>` on the deployment. Shown once, never recoverable.    |
| `projects`      | Comma-separated slugs this session should be woken for, or `*` for every project. **Required.**       |

Both servers take the **same** token on purpose. The channel says "you have
work" and the tools are what read it, so a second identity would announce cards
that `get_messages` could not find.

`projects` has no default on purpose. It used to be optional, and blank meant
"work out what this agent cares about from what it has done" — which made the
commonest configuration the one nobody had chosen, and let a session's scope
accumulate out of its own history rather than being decided by whoever set it up.
`*` says every project, and it has to be typed.

The channel is a research preview and this plugin is not on Anthropic's
allowlist, so a session opts in at launch:

```sh
claude --dangerously-load-development-channels plugin:agent-dashboard@agent-dashboard
```

Without the flag every tool still works. The only loss is latency: a reply lands
on the next `heartbeat` rather than instantly.

## The monitor, which starts by itself

A channel needs `--dangerously-load-development-channels`, so most sessions do
not have one and would hear nothing until their next `heartbeat`. A **monitor**
needs no flag: Claude Code runs it in the background for the whole session — no
30-minute cap, no re-arming — and turns every line it writes to stdout into a
notification. `bin/monitor.mjs` is the same bridge with a different mouth:
`runBridge` does the reading, the backoff and the deciding, and `notify` writes
a line.

Since 0.2.0 it is declared `when: "always"`, so it starts with the session.
Before that it was `on-skill-invoke:watching-the-dashboard`, which in practice
meant it never ran: the skill has to be dispatched before anything starts, and
nothing dispatched it.

### How the two stay out of each other's way

Both could run in one session, and everything would arrive twice. So the channel
stamps `${CLAUDE_PLUGIN_DATA}/channel.alive` every 20 seconds while it is up, and
the monitor stands by while that claim is fresh (`src/channel/claim.ts`). The
claim carries the session id when Claude Code gives one, so a channel in one
session cannot silence a monitor in another; with no session id it falls back to
"is that process still alive". A stale claim — a channel that was killed — is
ignored after 90 seconds and the monitor takes over.

To turn the monitor off for good, set `monitor: off` under /plugin or
`AGENT_DASHBOARD_MONITOR=off`.

### Where the configuration comes from

`scripts/session-start.sh` takes the plugin's options when they are set and
`AGENT_DASHBOARD_URL` / `AGENT_DASHBOARD_TOKEN` / `AGENT_DASHBOARD_PROJECTS`
otherwise — **the plugin options win** — and writes
`${CLAUDE_PLUGIN_DATA}/connection.json` (mode 0600; it holds a bearer token).
"Not configured" is said only when neither source has a URL and a token.

That bridge exists because of two platform constraints:

- **A monitor command cannot read `${user_config.*}`**, and the process is given
  no `CLAUDE_PLUGIN_OPTION_*` either — so the plugin's own settings are invisible
  from inside it. A hook _is_ given them, which makes the hook the only thing
  that can hand them over. In the monitor process itself the environment wins
  over the file, which keeps it runnable by hand.
- **Every line is a notification**, so a markdown body that kept its newlines
  would arrive as a burst of interruptions carrying one thought. `oneLine`
  flattens it and marks the cut with an ellipsis rather than pretending the rest
  was not there.

### What it says about itself

stderr reaches nobody in a session, so three things are said on stdout, once
each: `connected` when the stream opens, `not configured` when there is nothing
to connect with (after 20 seconds, so the hook has had its chance), and
`refused (401)` when the token is rejected. Reconnects stay quiet — a dashboard
that restarted is the ordinary weather of a long session, not news.

## Why `bin/channel.mjs` is committed, and bundled whole

A plugin is installed by cloning a directory. There is no `npm install` step and
no `node_modules` beside it, so this build inlines `@modelcontextprotocol/sdk`
rather than leaving it external the way `build/channel.js` does — a bare import
would resolve to nothing on the user's machine and the channel would fail to
spawn with a module-not-found, which is the one error a user cannot act on.

It is generated, so it is never edited by hand:

```sh
npm run build:plugin        # src/channel/ → plugins/agent-dashboard/bin/channel.mjs
```

`src/plugin.test.ts` fails if the committed bundle is missing, is not
self-contained, or drifts from the source it claims to be built from.

## Why the knowledge is in skills rather than only in tool descriptions

Tool descriptions are loaded whether or not they are relevant, and they are read
one tool at a time. The three things an agent most reliably gets wrong here span
several tools each — that `pending` is not an answer, that `level` and `priority`
are different questions, that work another agent has marked `in_progress` is not
yours to take — and
none of them fits in the description of a single tool. A skill is loaded when the
situation arises and can say the whole thing in one place.
