---
description: Verify the Agent Dashboard plugin is configured and reachable, and say exactly what is wrong if not.
allowed-tools: Bash
---

Check the dashboard connection end to end and report each step.

1. **Tools present.** Are the `agent-dashboard` MCP tools available in this
   session? If not, the plugin is installed but not configured or not enabled —
   the `dashboard_url` and `agent_token` come from `/plugin` and there is nothing
   to guess.
2. **The server answers you.** Call `list_projects()`. Interpret the failure
   rather than repeating it:
   - HTTP 401 → the token is missing, malformed or revoked. It has to be re-minted
     on the deployment with `agent-dashboard mint-token <name>`; it cannot be
     recovered.
   - a connection failure → `dashboard_url` is wrong, or the deployment is not
     reachable from this machine. It must be the **origin** only, with no trailing
     slash and no `/mcp`.
   - HTTP 429 → it is reachable and you are just being rate limited. That is a
     pass.
3. **The channel.** Is `agent-dashboard-channel` loaded in this session? If the
   tools work but the channel is absent, the session was started without
   `--dangerously-load-development-channels plugin:agent-dashboard@agent-dashboard`.
   Everything still works; replies just arrive on your next heartbeat instead of
   instantly. Say that rather than reporting it as broken.

Report a short verdict per step and, if anything failed, the one command or
setting that fixes it.
