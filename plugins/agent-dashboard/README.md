# `plugins/agent-dashboard` — the whole client side, as one plugin

**One job:** everything an agent needs to use a deployment of this dashboard,
installed with one command and configured with two values.

Before this existed, connecting an agent meant a `claude mcp add` for the remote
server, a second hand-written `.mcp.json` entry pointing at a `build/channel.js`
somewhere on disk, and the knowledge of how to use seventeen tools living only in
their descriptions. The plugin is those three things packaged.

## What is in it

| Piece                           | Is                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.mcp.json` → `agent-dashboard` | The remote Streamable HTTP server at `<url>/mcp`, bearer-authenticated.                                                   |
| `.mcp.json` → `..._channel`     | The stdio bridge, so a reply reaches a running session in milliseconds.                                                   |
| `bin/channel.mjs`               | That bridge, built from `src/channel/` and **committed**. See below.                                                      |
| `skills/agent-dashboard`        | The run's shape: register, heartbeat, project, end.                                                                       |
| `skills/posting-updates`        | What is worth a card, level vs priority, media, corrections.                                                              |
| `skills/asking-the-owner`       | The six `request_input` kinds and the `await_request` wait loop.                                                          |
| `skills/working-the-task-board` | Claiming, contention, finishing, filing follow-ups.                                                                       |
| `commands/`                     | `/dashboard-online`, `/dashboard-report`, `/dashboard-ask`, `/dashboard-tasks`, `/dashboard-offline`, `/dashboard-check`. |
| `hooks/hooks.json`              | One `SessionStart` line saying a human is watching, or how to configure.                                                  |

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

Both servers take the **same** token on purpose. The channel says "you have a
task" and the tools are what read it, so a second identity would announce work
that `list_tasks` could not find.

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

## The monitor, for sessions with no channel

A channel needs `--dangerously-load-development-channels`, so most sessions do
not have one and hear nothing until their next `heartbeat`. A **monitor** needs
no flag: Claude Code runs it in the background and turns every line it writes to
stdout into a notification. `bin/monitor.mjs` is the same bridge with a different
mouth — `runBridge` does the reading, the backoff and the deciding, and `notify`
writes a line.

It is declared `when: "on-skill-invoke:watching-the-dashboard"` rather than
`always`, and that is the whole of how the two stay out of each other's way: an
agent that already has the channel never invokes the skill, and an agent that
does not, does. Running both would deliver every reply twice.

Two constraints shape it, and both come from the platform:

- **A monitor command cannot read `${user_config.*}`**, and the process is given
  no `CLAUDE_PLUGIN_OPTION_*` either — so the plugin's own settings are invisible
  from inside it. A hook _is_ given them, so `scripts/session-start.sh` writes
  `${CLAUDE_PLUGIN_DATA}/connection.json` (mode 0600 — it holds a bearer token)
  and the monitor reads it. Environment variables win when set, which keeps it
  runnable by hand.
- **Every line is a notification**, so a markdown body that kept its newlines
  would arrive as a burst of interruptions carrying one thought. `oneLine`
  flattens it and marks the cut with an ellipsis rather than pretending the rest
  was not there.

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
are different questions, that a lost `claim_task` race must not be retried — and
none of them fits in the description of a single tool. A skill is loaded when the
situation arises and can say the whole thing in one place.
