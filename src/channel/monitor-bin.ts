/**
 * Entry point for the monitor (`bin/monitor.mjs`).
 *
 * Claude Code runs this as a background process for the life of a session and
 * turns every line it writes to stdout into a notification. Since plugin 0.2.0
 * it starts by itself (`monitors.json` says `"when": "always"`), so a session
 * hears from the dashboard without anybody invoking a skill first.
 *
 * ## Where the connection comes from
 *
 * A monitor command **cannot** reference `${user_config.*}`, and a monitor
 * process is not given `CLAUDE_PLUGIN_OPTION_*` either — so the plugin's own
 * settings are invisible from here. The documented answer is for the monitor to
 * read a file it owns, and this plugin's `SessionStart` hook is the half that
 * can see the settings, so the hook writes the file and this reads it.
 *
 * The environment wins over the file, which keeps this runnable by hand and
 * outside a plugin entirely:
 *
 *     AGENT_DASHBOARD_URL=… AGENT_DASHBOARD_TOKEN=… \
 *     AGENT_DASHBOARD_PROJECTS='*' node build/monitor.js
 *
 * ## It waits rather than exiting, but it says so
 *
 * A monitor that exited because the hook had not run yet would be a fallback
 * that fails exactly when it is needed — Claude Code does not restart it. So a
 * missing configuration is a wait. What is new in 0.2.0 is that the wait is
 * *audible*: after {@link SAY_AFTER_MS} it writes one line to stdout, because
 * stderr reaches nobody and a misconfigured monitor otherwise looks exactly
 * like a quiet dashboard.
 *
 * ## It stands aside for the channel
 *
 * A session that has the channel is already being told everything. Both running
 * would mean every reply arriving twice, so the channel stamps a claim and this
 * waits quietly while that claim is fresh (`./claim.ts`), taking over if the
 * channel goes away. `monitor: off` turns this half off for good.
 */
import { channelIsLive, CLAIM_EVERY_MS } from './claim';
import { readConnection, runMonitor } from './monitor';

/** Milliseconds between looks for a configuration that is not there yet. */
const WAIT_MS = 5_000;

/**
 * How long to wait before saying nothing is configured.
 *
 * Long enough for the `SessionStart` hook to have written its file — the hook
 * and this process start at the same moment — and short enough that somebody
 * watching a fresh session sees the answer rather than wondering.
 */
const SAY_AFTER_MS = 20_000;

/* c8 ignore start -- the process wrapper; `runMonitor`, `readConnection` and `channelIsLive` are what is tested. */
async function main(): Promise<void> {
	const started = Date.now();
	let saidUnconfigured = false;
	let saidStandby = false;

	for (;;) {
		const connection = readConnection(process.env);

		if (connection && connection.monitor === 'off') {
			// Asked for explicitly. Nothing to say: somebody chose this.
			process.stderr.write('agent-dashboard monitor: off by configuration\n');
			return;
		}

		if (connection && channelIsLive(process.env)) {
			if (!saidStandby) {
				saidStandby = true;
				process.stderr.write(
					'agent-dashboard monitor: the channel is delivering for this session; standing by\n'
				);
			}
			// Re-checked rather than exiting: a channel that dies mid-session should
			// leave this one delivering rather than leave the session deaf.
			await new Promise((resolve) => setTimeout(resolve, CLAIM_EVERY_MS));
			continue;
		}

		if (connection) {
			await runMonitor(connection);
			return;
		}

		if (!saidUnconfigured && Date.now() - started >= SAY_AFTER_MS) {
			saidUnconfigured = true;
			// stdout, so it reaches the session: this is the case the owner could
			// not see before, and silence reads as "the dashboard is quiet".
			process.stdout.write(
				'agent-dashboard monitor: not configured — nothing will arrive from the dashboard. ' +
					'Set dashboard_url, agent_token and projects under /plugin, or set ' +
					'AGENT_DASHBOARD_URL, AGENT_DASHBOARD_TOKEN and AGENT_DASHBOARD_PROJECTS in the ' +
					'environment, then restart the session.\n'
			);
		}

		await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
	}
}

await main();
/* c8 ignore stop */
