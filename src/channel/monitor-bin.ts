/**
 * Entry point for the monitor (`bin/monitor.mjs`).
 *
 * Claude Code runs this as a background process for the life of a session and
 * turns every line it writes to stdout into a notification.
 *
 * ## Where the connection comes from, and why it is not the plugin's config
 *
 * A monitor command **cannot** reference `${user_config.*}`, and a monitor
 * process is not given `CLAUDE_PLUGIN_OPTION_*` either — so the plugin's own
 * settings are invisible from here. The documented answer is for the monitor to
 * read a file it owns, and this plugin's `SessionStart` hook is the half that
 * can see the settings, so the hook writes the file and this reads it.
 *
 * Environment variables win when they are set, which keeps this runnable by
 * hand and outside a plugin entirely:
 *
 *     AGENT_DASHBOARD_URL=… AGENT_DASHBOARD_TOKEN=… \
 *     AGENT_DASHBOARD_PROJECTS='*' node build/monitor.js
 *
 * ## It waits rather than exiting
 *
 * A monitor that exited because the hook had not run yet would be a fallback
 * that fails exactly when it is needed and leaves nothing behind to say why —
 * Claude Code does not restart it. So a missing configuration is a wait, with
 * one line on stderr the first time so it is diagnosable at all.
 */
import { readConnection, runMonitor } from './monitor';

/** Milliseconds between looks for a configuration that is not there yet. */
const WAIT_MS = 5_000;

/* c8 ignore start -- the process wrapper; `runMonitor` and `readConnection` are what is tested. */
async function main(): Promise<void> {
	let said = false;
	for (;;) {
		const connection = readConnection(process.env);
		if (connection) {
			await runMonitor(connection);
			return;
		}

		if (!said) {
			said = true;
			process.stderr.write(
				'agent-dashboard monitor: no connection yet — waiting for the plugin to be ' +
					'configured (dashboard URL, token and projects), or set AGENT_DASHBOARD_URL, ' +
					'AGENT_DASHBOARD_TOKEN and AGENT_DASHBOARD_PROJECTS.\n'
			);
		}
		await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
	}
}

await main();
/* c8 ignore stop */
