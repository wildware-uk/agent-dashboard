#!/bin/sh
# Injected at the top of every session the plugin is enabled in, and the one
# thing that can hand the monitor its connection.
#
# It says the one thing a session cannot work out for itself — that a human is
# watching this deployment and how to reach them — and then gets out of the way.
# Deliberately short: a paragraph here is paid for on every single session, and a
# reminder nobody reads is worse than none.
#
# When the plugin has no URL configured the tools cannot authenticate at all, so
# the useful thing to say is how to configure it, not how to report.

# ── The monitor's connection ──────────────────────────────────────────────────
#
# A monitor command cannot reference ${user_config.*}, and a monitor process is
# not given CLAUDE_PLUGIN_OPTION_* either — so the plugin's settings are
# invisible from inside it. A hook *is* given them, which makes this script the
# only place that can bridge the two. It writes what the monitor reads.
#
# 0600, because the file holds a bearer token: it is the agent's whole identity,
# and anything that can read it can post as that agent.
if [ -n "$CLAUDE_PLUGIN_DATA" ] && [ -n "$CLAUDE_PLUGIN_OPTION_DASHBOARD_URL" ]; then
	mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null || true
	umask 077
	cat >"$CLAUDE_PLUGIN_DATA/connection.json" <<JSON 2>/dev/null || true
{
	"url": "$CLAUDE_PLUGIN_OPTION_DASHBOARD_URL",
	"token": "$CLAUDE_PLUGIN_OPTION_AGENT_TOKEN",
	"projects": "$CLAUDE_PLUGIN_OPTION_PROJECTS"
}
JSON
fi

if [ -z "$CLAUDE_PLUGIN_OPTION_DASHBOARD_URL" ]; then
	cat <<'MSG'
Agent Dashboard: enabled but not configured — the `agent-dashboard` MCP tools will not
authenticate. Set `dashboard_url` and `agent_token` under /plugin (the token comes from
`agent-dashboard mint-token <name>` on the deployment). Run /dashboard-check to confirm.
MSG
	exit 0
fi

cat <<MSG
Agent Dashboard is connected at $CLAUDE_PLUGIN_OPTION_DASHBOARD_URL — a human owner may be
watching this run there. Call register_session at the start, heartbeat on the interval it
returns, post_update when something is worth a glance, and request_input (then await_request
while it answers "pending") rather than guessing or stopping on an unanswered question. Read
the agent-dashboard skill for the rest. /dashboard-online opens a session now.

If the agent-dashboard-channel tools are NOT in this session, you will not hear a reply until
your next heartbeat — invoke the watching-the-dashboard skill to start the fallback monitor.
MSG
