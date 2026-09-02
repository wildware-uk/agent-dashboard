# `src/channel` — the Claude Code channel bridge

**One job:** turn work waiting on the dashboard into a
[Claude Code channel](https://code.claude.com/docs/en/channels-reference)
notification, so an agent hears about a reply or a task the moment it happens
instead of on its next `heartbeat`.

**May import:** nothing from this tree. Only `@modelcontextprotocol/sdk`.

**Must not:** touch the database, the event bus, or the domain. This process runs
beside the **agent**, which is not necessarily the dashboard's machine. It is an
ordinary HTTP client of the deployment, holding one bearer token, and it has no
write path at all.

Public entry point: `src/channel/index.ts`. Built separately to `build/channel.js`
by `npm run build:channel`.

## Why a separate process exists

A channel is an MCP server that **Claude Code spawns itself, over stdio**. The
dashboard's own MCP server is remote — Streamable HTTP at `/mcp` behind a bearer
token — and a remote server cannot be a channel: there is no stdio to spawn it
on. This bridge is the missing half.

```
dashboard ──SSE /api/agent/stream──▶ bridge ──stdio notification──▶ Claude Code
```

## What is here

| File        | Holds                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| `bridge.ts` | The channel capability, the SSE reader, the backoff loop, and what to say. |
| `bin.ts`    | The entry point Claude Code spawns. Nothing but a call to `main`.          |

## It carries news, not content

`/api/agent/stream` sends the three counts a heartbeat answers with, and nothing
else (`src/http/stream/agent.ts` explains why). So a notification says _that_
there is a reply or a task; the agent reads it with the tools it already has on
the remote server — `get_messages`, `list_tasks`, `await_request`. The channel
removes the waiting, not the tools.

Two consequences, both deliberate:

- **One-way.** No `tools` capability and no reply tool. Claude already has the
  dashboard's full tool surface; a second `post_update` over another transport
  would be two ways to do one thing, and they would drift.
- **No permission relay.** `claude/channel/permission` would let whoever can
  reach the dashboard approve tool calls in the agent's session. This bridge
  authenticates the _deployment_, not the person typing into it, and the channel
  docs are explicit that relay belongs only to a channel that gates on sender.

## Subscribing to projects — required, never inferred

A session dedicated to one project should be deaf to every other, however many
the token has touched over its life. `AGENT_DASHBOARD_PROJECTS` is that
subscription, and the bridge **refuses to start without it**:

```json
"env": {
  "AGENT_DASHBOARD_URL": "https://agents.example.com",
  "AGENT_DASHBOARD_TOKEN": "...",
  "AGENT_DASHBOARD_PROJECTS": "megamerge-mod-engine"
}
```

`*` is how you say every project, and it has to be typed:

```json
"AGENT_DASHBOARD_PROJECTS": "*"
```

This used to be optional, and an unset variable meant "derive relevance from what
this agent has done" — updates it posted, tasks assigned to it, threads it has
spoken in. That made the commonest configuration the one nobody had chosen, and
it let a session's scope _accumulate_: what woke an agent was decided by its own
history rather than by whoever set the session up, and the way to discover the
scope was to be interrupted by it. One line of config is cheaper than that.

`*` is deliberately **wider** than the old derived rule, not the same thing: it
carries projects this agent has never been near, because a session that asks for
everything means everything. The derived behaviour still exists on the stream
itself for any client that sends no `project` at all — it is only the bridge
that now insists.

Two refusals, because both are mistakes a silent default would hide:

- a slug that names no project is a **404 on the stream**, not an empty
  subscription: a typo that silently carried nothing would look exactly like a
  quiet dashboard.
- `*` alongside a slug is a **400**. The caller cannot have meant both, and
  honouring either half would hide the mistake.

## Only rises are announced

A frame arrives whenever any count moves, including when the agent clears its
own inbox. `describeRise` says something only about counts that went **up**:
"you have 0 messages" is an interruption that costs a turn to read and teaches
the agent to ignore the channel.

## Losing the connection is safe

Every reconnect opens with the current counts rather than a replay, and the
counts are absolute rather than deltas. A dropped stream therefore costs
latency and never correctness — the worst case is a late notification, never a
wrong one. The bridge backs off `1s, 2s, 5s, 10s, 30s` and holds there, and it
never exits on a connection error: a bridge that gave up would need the whole
session restarted to come back.

## Running it

The ordinary way is not to run it by hand at all: `plugins/agent-dashboard/`
ships this bridge as part of the Claude Code plugin, bundled whole (SDK inlined,
since a plugin is cloned and never `npm install`ed) by `npm run build:plugin`.
What follows is the same thing wired up manually.

Two environment variables, both of which the agent's MCP config already knows:

| Variable                   | Meaning                                             |
| -------------------------- | --------------------------------------------------- |
| `AGENT_DASHBOARD_URL`      | e.g. `https://agents.example.com`                   |
| `AGENT_DASHBOARD_TOKEN`    | the agent's bearer token, from `mint-token`         |
| `AGENT_DASHBOARD_PROJECTS` | optional: comma-separated slugs this session is for |

```json
{
	"mcpServers": {
		"agent-dashboard-channel": {
			"command": "node",
			"args": ["/path/to/build/channel.js"],
			"env": {
				"AGENT_DASHBOARD_URL": "https://agents.example.com",
				"AGENT_DASHBOARD_TOKEN": "..."
			}
		}
	}
}
```

Channels are a research preview and custom ones are not on Anthropic's
allowlist, so the session has to opt in explicitly:

```sh
claude --dangerously-load-development-channels server:agent-dashboard-channel
```

Diagnostics go to **stderr** only. stdout is the MCP transport, and a stray line
on it is a protocol error rather than a message anybody reads.
