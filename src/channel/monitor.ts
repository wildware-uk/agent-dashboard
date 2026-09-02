/**
 * The dashboard as a Claude Code **monitor** — the fallback for sessions where
 * channels are off.
 *
 * A channel is the good version of this: it pushes a structured notification
 * into a running session. But channels are a research preview, custom ones are
 * not on Anthropic's allowlist, and a session only gets one if it was launched
 * with `--dangerously-load-development-channels`. Every other session — which is
 * most of them — hears nothing until its next `heartbeat`.
 *
 * A monitor needs no flag. Claude Code runs the command for the life of the
 * session and turns **every line it writes to stdout** into a notification. So
 * this is the same bridge with a different mouth: `runBridge` does the reading,
 * the backoff and the deciding, and `notify` writes a line instead of a
 * `notifications/claude/channel`.
 *
 * ```
 *   dashboard ──SSE /api/agent/stream──▶ monitor (this file) ──stdout line──▶ Claude Code
 * ```
 *
 * Two differences from the channel, both forced by the transport:
 *
 * - **One line per notification.** A message body is markdown and often several
 *   paragraphs; delivered raw it would become one notification per line, which
 *   is a burst of interruptions carrying one thought. {@link oneLine} collapses
 *   it and says so with an ellipsis rather than pretending the rest was not
 *   there.
 * - **No metadata.** A channel event carries ids on the tag; a line of stdout is
 *   a line of stdout. The ids are in the tools, which is where an agent has to
 *   go anyway — so the line says what happened and which project, and
 *   `get_messages` does the rest.
 *
 * Diagnostics still go to stderr, and now it matters twice over: on the channel
 * stdout was the MCP transport, and here it is the notification stream. A stray
 * log line would become a notification.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBridge } from './bridge';

/** How much of a message body one notification carries. */
export const LINE_MAX = 300;

/**
 * A notification as a single line.
 *
 * Newlines and runs of whitespace become single spaces, because the transport
 * is line-based and a body that kept its own would arrive as several
 * interruptions rather than one. Over-long text is cut at a word boundary with
 * an ellipsis: the agent is being told *that* something happened and roughly
 * what, and it reads the rest with the tools.
 */
export function oneLine(content: string, max = LINE_MAX): string {
	const flat = content.replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;

	const head = flat.slice(0, max - 1);
	const space = head.lastIndexOf(' ');
	return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export type MonitorOptions = {
	baseUrl: string;
	token: string;
	projects: readonly string[];
	/** Test seam: where a line goes. Defaults to stdout. */
	write?: (line: string) => void;
	/** Test seam: diagnostics. Defaults to stderr. */
	log?: (message: string) => void;
	fetch?: typeof globalThis.fetch;
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
};

/** Read the dashboard until the session ends, writing one line per event. */
export async function runMonitor(options: MonitorOptions): Promise<void> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const log =
		options.log ??
		((message: string) => process.stderr.write(`agent-dashboard monitor: ${message}\n`));

	await runBridge({
		baseUrl: options.baseUrl,
		token: options.token,
		projects: options.projects,
		fetch: options.fetch,
		sleep: options.sleep,
		signal: options.signal,
		log,
		notify: (content) => {
			write(oneLine(content));
			return Promise.resolve();
		}
	});
}

/** What the `SessionStart` hook writes, and this reads. */
export const CONNECTION_FILE = 'connection.json';

export type Connection = { baseUrl: string; token: string; projects: string[] };

/** Split the comma-separated subscription the same way the channel does. */
function subscription(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((project) => project.trim())
		.filter((project) => project !== '');
}

/**
 * The connection, from the environment or from the hook's file.
 *
 * `null` rather than a throw: the caller waits, because the file arriving a
 * moment later is the ordinary case rather than an error.
 */
export function readConnection(env: NodeJS.ProcessEnv, read = readFileSync): Connection | null {
	const fromEnv = {
		baseUrl: env.AGENT_DASHBOARD_URL?.trim(),
		token: env.AGENT_DASHBOARD_TOKEN?.trim(),
		projects: subscription(env.AGENT_DASHBOARD_PROJECTS)
	};
	if (fromEnv.baseUrl && fromEnv.token && fromEnv.projects.length > 0) {
		return { baseUrl: fromEnv.baseUrl, token: fromEnv.token, projects: fromEnv.projects };
	}

	const dir = env.CLAUDE_PLUGIN_DATA?.trim();
	if (!dir) return null;

	try {
		const stored: unknown = JSON.parse(String(read(join(dir, CONNECTION_FILE), 'utf8')));
		if (typeof stored !== 'object' || stored === null) return null;

		const { url, token, projects } = stored as Record<string, unknown>;
		const wanted = subscription(typeof projects === 'string' ? projects : undefined);
		if (typeof url !== 'string' || typeof token !== 'string' || wanted.length === 0) return null;

		return { baseUrl: url.trim(), token: token.trim(), projects: wanted };
	} catch {
		// Absent, half-written, or not JSON. All three mean "not yet".
		return null;
	}
}
