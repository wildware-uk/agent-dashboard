#!/bin/sh
# Injected at the top of every session the plugin is enabled in.
#
# It says the one thing a session cannot work out for itself — that a human is
# watching this deployment and how to reach them — and then gets out of the way.
# Deliberately short: a paragraph here is paid for on every single session, and a
# reminder nobody reads is worse than none.
#
# When the plugin has no URL configured the tools cannot authenticate at all, so
# the useful thing to say is how to configure it, not how to report.

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
MSG
