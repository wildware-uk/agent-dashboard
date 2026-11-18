# Changelog

## 0.2.0

The monitor starts by itself and stays up for the whole session.

### The monitor runs without being asked

- `monitors/monitors.json` declares `"when": "always"` instead of
  `"on-skill-invoke:watching-the-dashboard"`. The old trigger meant the monitor
  never ran in practice — the skill had to be dispatched first, and nothing
  dispatched it, so sessions without a channel heard nothing until their next
  `heartbeat`.
- Claude Code runs a plugin monitor for the life of the session. There is no
  30-minute cap to re-arm, unlike the Monitor tool.

### Nothing arrives twice

- The channel stamps `${CLAUDE_PLUGIN_DATA}/channel.alive` every 20 seconds
  while it runs; the monitor stands by while that claim is fresh and takes over
  if it goes stale (90 seconds). The claim carries the session id when Claude
  Code provides one, so a channel in one session cannot silence a monitor in
  another.
- New `monitor` option (`auto` by default, or `off`), also readable as
  `AGENT_DASHBOARD_MONITOR`.

### Configuration comes from the environment too

- `scripts/session-start.sh` now reads `AGENT_DASHBOARD_URL`,
  `AGENT_DASHBOARD_TOKEN` and `AGENT_DASHBOARD_PROJECTS` when the plugin's own
  options are unset, and writes `connection.json` (0600) from whichever source
  it finds. The plugin options win when both are set.
- "Enabled but not configured" is now said only when neither source has a URL
  and a token. Before, a session configured entirely by environment variables
  was told it was unconfigured while its MCP tools worked perfectly — and the
  monitor had nothing to read.

### Failures are visible

- The monitor writes one stdout line — which is what becomes a notification —
  when it is not configured, and one when the dashboard refuses the connection
  (401 says the token is wrong or revoked). It already said `connected`; that
  now reaches the session rather than stderr.
- Reconnects stay quiet: a dashboard that restarted is not news.

### Documentation caught up with the server

- `skills/watching-the-dashboard` no longer tells agents to use `list_tasks` and
  `claim_task`, which the server removed when the board became a state on a card
  (migration 035). It says `list_work` and `set_status`, and explains that the
  monitor starts on its own.
- The channel's own MCP instructions said the same two dead tools. Fixed.

## 0.1.0

First release: MCP tools, the channel bridge, the monitor, skills and commands.
