#!/bin/sh
# Injected at the top of every session the plugin is enabled in, and the one
# thing that can hand the monitor its connection.
#
# It says the one thing a session cannot work out for itself — that a human is
# watching this deployment and how to reach them — and then gets out of the way.
# Deliberately short: a paragraph here is paid for on every single session, and a
# reminder nobody reads is worse than none.

# ── Where the configuration comes from ────────────────────────────────────────
#
# Two sources, and both are ordinary:
#
#   1. the plugin's own options, set under /plugin (CLAUDE_PLUGIN_OPTION_*);
#   2. the environment (AGENT_DASHBOARD_*), which is what a shell profile, a
#      launcher script or a container sets.
#
# **The plugin options win**, because they are the setting somebody made for
# this install through a control that shows them what it is; the environment is
# the fallback. Before 0.2.0 only the first was read, so a session configured
# entirely by env vars was told it was "not configured" while its MCP tools
# worked perfectly — and the monitor, which reads what this writes, had nothing.
URL="${CLAUDE_PLUGIN_OPTION_DASHBOARD_URL:-$AGENT_DASHBOARD_URL}"
TOKEN="${CLAUDE_PLUGIN_OPTION_AGENT_TOKEN:-$AGENT_DASHBOARD_TOKEN}"
PROJECTS="${CLAUDE_PLUGIN_OPTION_PROJECTS:-$AGENT_DASHBOARD_PROJECTS}"
MONITOR="${CLAUDE_PLUGIN_OPTION_MONITOR:-${AGENT_DASHBOARD_MONITOR:-auto}}"

# ── The monitor's connection ──────────────────────────────────────────────────
#
# A monitor command cannot reference ${user_config.*}, and a monitor process is
# not given CLAUDE_PLUGIN_OPTION_* either — so the plugin's settings are
# invisible from inside it. A hook *is* given them, which makes this script the
# only place that can bridge the two. It writes what the monitor reads.
#
# 0600, because the file holds a bearer token: it is the agent's whole identity,
# and anything that can read it can post as that agent.
if [ -n "$CLAUDE_PLUGIN_DATA" ] && [ -n "$URL" ] && [ -n "$TOKEN" ]; then
	mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null || true
	umask 077
	cat >"$CLAUDE_PLUGIN_DATA/connection.json" <<JSON 2>/dev/null || true
{
	"url": "$URL",
	"token": "$TOKEN",
	"projects": "$PROJECTS",
	"monitor": "$MONITOR"
}
JSON
fi

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
	cat <<'MSG'
Agent Dashboard: enabled but not configured — the `agent-dashboard` MCP tools will not
authenticate and nothing will arrive from the dashboard. Set `dashboard_url` and
`agent_token` under /plugin (the token comes from `agent-dashboard mint-token <name>` on
the deployment), or set AGENT_DASHBOARD_URL and AGENT_DASHBOARD_TOKEN in the environment.
Run /dashboard-check to confirm.
MSG
	exit 0
fi

cat <<MSG
Agent Dashboard is connected at $URL — a human owner may be watching this run there. Call
register_session at the start, heartbeat on the interval it returns, post_update when
something is worth a glance, and request_input (then await_request while it answers
"pending") rather than guessing or stopping on an unanswered question. Read the
agent-dashboard skill for the rest. /dashboard-online opens a session now.

A background monitor starts with this session and delivers replies, questions and work as
they happen — you do not need to invoke anything to turn it on. It stands aside on its own
while the agent-dashboard-channel is running, so nothing arrives twice.
MSG
