import { describe, expect, it, vi } from 'vitest';
import { LINE_MAX, oneLine, readConnection, runMonitor } from './monitor';

/**
 * The monitor: the same bridge with a different mouth.
 *
 * `bridge.test.ts` covers the reading, the backoff and what is worth
 * announcing. What is only true here is the transport: Claude Code turns every
 * **line** of stdout into a notification, so a body that kept its own newlines
 * would arrive as a burst of interruptions carrying one thought.
 */
describe('one line per notification', () => {
	it('flattens a multi-line body into a single line', () => {
		expect(oneLine('first line\n\nsecond line')).toBe('first line second line');
	});

	it('collapses runs of whitespace, including tabs', () => {
		expect(oneLine('  spaced \t   out  \n  text ')).toBe('spaced out text');
	});

	it('leaves a short line exactly as it is', () => {
		expect(oneLine('2 open tasks')).toBe('2 open tasks');
	});

	it('cuts an over-long body at a word boundary and says it was cut', () => {
		const long = `${'word '.repeat(200)}end`;

		const line = oneLine(long);

		expect(line.length).toBeLessThanOrEqual(LINE_MAX);
		expect(line.endsWith('…')).toBe(true);
		expect(line).not.toMatch(/wor…$/);
	});

	it('still cuts when there is no space to cut at', () => {
		expect(oneLine('x'.repeat(500)).length).toBeLessThanOrEqual(LINE_MAX);
	});
});

describe('writing to the session', () => {
	/** One SSE body, the way the dashboard sends it. */
	function stream(frames: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const frame of frames) controller.enqueue(encoder.encode(frame));
				controller.close();
			}
		});
	}

	const work = (counts: Record<string, number>) =>
		`event: work\ndata: ${JSON.stringify({
			type: 'work',
			unread_messages: 0,
			open_tasks: 0,
			pending_approvals: 0,
			at: new Date().toISOString(),
			...counts
		})}\n\n`;

	async function monitor(frames: string[]) {
		const written: string[] = [];
		const abort = new AbortController();
		const fetcher = vi.fn().mockResolvedValue(new Response(stream(frames), { status: 200 }));

		await runMonitor({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['*'],
			write: (line) => written.push(line),
			log: () => {},
			fetch: fetcher as unknown as typeof globalThis.fetch,
			// The loop reconnects for ever; aborting during the first backoff gives
			// one pass and then stops.
			sleep: async () => abort.abort(),
			signal: abort.signal
		});

		return { written, fetcher };
	}

	it('writes a line when work arrives', async () => {
		const { written } = await monitor([work({}), work({ open_tasks: 2 })]);

		// The first line is the monitor saying it is up (plugin 0.2.0): on a
		// monitor stderr reaches nobody, so "connected" has to be a notification
		// or a session cannot tell a working monitor from a quiet dashboard.
		expect(written).toEqual([
			'agent-dashboard monitor: connected — watching the dashboard for this session.',
			'Waiting for you on the dashboard: 2 open tasks.'
		]);
	});

	it('says nothing about a count that fell', async () => {
		// Clearing your own inbox is not news, and interrupting an agent to tell it
		// so is how a notification stream teaches its reader to ignore it. The
		// first frame is the baseline the stream opens with.
		const { written } = await monitor([work({}), work({ open_tasks: 2 }), work({ open_tasks: 0 })]);

		expect(written.filter((line) => !line.startsWith('agent-dashboard monitor:'))).toHaveLength(1);
	});

	it('asks for the same stream the channel does, with the same subscription', async () => {
		const { fetcher } = await monitor([work({})]);

		const asked = new URL(fetcher.mock.calls[0]?.[0] as string);
		expect(asked.origin + asked.pathname).toBe('https://dash.test/api/agent/stream');
		expect(asked.searchParams.get('project')).toBe('*');
		// And it names itself, so its deliveries are its own (migration 019).
		expect(asked.searchParams.get('client')).toMatch(/^bridge-/);
		expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: 'Bearer a-token'
		});
	});
});

/**
 * Where the connection comes from.
 *
 * A monitor cannot read `${user_config.*}` and is given no
 * `CLAUDE_PLUGIN_OPTION_*`, so the plugin's `SessionStart` hook writes a file
 * and this reads it. Environment variables win, which keeps it runnable by hand.
 */
describe('finding the dashboard', () => {
	const file = (contents: string) => () => contents;

	it('takes the environment when it is complete', () => {
		const found = readConnection({
			AGENT_DASHBOARD_URL: 'https://dash.test',
			AGENT_DASHBOARD_TOKEN: 'a-token',
			AGENT_DASHBOARD_PROJECTS: 'one, two'
		});

		expect(found).toEqual({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['one', 'two'],
			monitor: 'auto'
		});
	});

	it('falls back to the file the hook wrote', () => {
		const found = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data' },
			file('{"url":"https://dash.test","token":"a-token","projects":"*"}') as never
		);

		expect(found).toEqual({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['*'],
			monitor: 'auto'
		});
	});

	it('prefers the environment over the file, so it can be run by hand', () => {
		const found = readConnection(
			{
				CLAUDE_PLUGIN_DATA: '/data',
				AGENT_DASHBOARD_URL: 'https://typed.test',
				AGENT_DASHBOARD_TOKEN: 'typed',
				AGENT_DASHBOARD_PROJECTS: '*'
			},
			file('{"url":"https://dash.test","token":"a-token","projects":"*"}') as never
		);

		expect(found?.baseUrl).toBe('https://typed.test');
	});

	it('reads the monitor switch from the file, and lets the environment override it', () => {
		const off = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data' },
			file('{"url":"https://dash.test","token":"t","projects":"*","monitor":"off"}') as never
		);
		expect(off?.monitor).toBe('off');

		const overridden = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data', AGENT_DASHBOARD_MONITOR: 'auto' },
			file('{"url":"https://dash.test","token":"t","projects":"*","monitor":"off"}') as never
		);
		expect(overridden?.monitor).toBe('auto');

		// Anything that is not "off" means the ordinary thing, rather than a third
		// state nobody documented.
		const nonsense = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data' },
			file('{"url":"https://dash.test","token":"t","projects":"*","monitor":"sometimes"}') as never
		);
		expect(nonsense?.monitor).toBe('auto');
	});

	it('takes the switch from the environment when the connection is from there too', () => {
		const found = readConnection({
			AGENT_DASHBOARD_URL: 'https://dash.test',
			AGENT_DASHBOARD_TOKEN: 'a-token',
			AGENT_DASHBOARD_PROJECTS: '*',
			AGENT_DASHBOARD_MONITOR: 'OFF'
		});

		expect(found?.monitor).toBe('off');
	});

	it('answers null rather than half a connection, so the caller waits', () => {
		expect(readConnection({ AGENT_DASHBOARD_URL: 'https://dash.test' })).toBeNull();
		expect(readConnection({})).toBeNull();
	});

	it('treats a subscription-less file as not ready, the way the channel refuses one', () => {
		const found = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data' },
			file('{"url":"https://dash.test","token":"a-token","projects":""}') as never
		);

		expect(found).toBeNull();
	});

	it('survives a file that is absent, half-written, or not JSON', () => {
		const throws = (() => {
			throw new Error('ENOENT');
		}) as never;

		expect(readConnection({ CLAUDE_PLUGIN_DATA: '/data' }, throws)).toBeNull();
		expect(readConnection({ CLAUDE_PLUGIN_DATA: '/data' }, file('{"url":') as never)).toBeNull();
		expect(readConnection({ CLAUDE_PLUGIN_DATA: '/data' }, file('null') as never)).toBeNull();
	});
});

/**
 * What the session is told about the monitor itself (plugin 0.2.0).
 *
 * The owner: "make failures visible… stderr never reaches the agent, so a
 * misconfigured monitor looks exactly like a quiet dashboard."
 */
describe('saying what the monitor is doing', () => {
	async function withRefusal(statuses: number[]) {
		const written: string[] = [];
		const abort = new AbortController();
		let call = 0;
		const fetcher = vi.fn(() => {
			const status = statuses[Math.min(call++, statuses.length - 1)];
			return Promise.resolve(new Response(null, { status }));
		});

		await runMonitor({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['*'],
			write: (line) => written.push(line),
			log: () => {},
			fetch: fetcher as unknown as typeof globalThis.fetch,
			sleep: async () => {
				if (call >= statuses.length) abort.abort();
			},
			signal: abort.signal
		});

		return written;
	}

	it('says so once when the token is refused', async () => {
		const written = await withRefusal([401, 401]);

		expect(written).toHaveLength(1);
		expect(written[0]).toContain('401');
		expect(written[0]).toContain('mint-token');
	});

	it('says so for any other refusal, without pretending it is the token', async () => {
		const written = await withRefusal([503, 503]);

		expect(written[0]).toContain('503');
		expect(written[0]).not.toContain('token is wrong');
	});

	it('stays quiet about an ordinary reconnect', async () => {
		const written: string[] = [];
		const abort = new AbortController();
		let call = 0;
		const encoder = new TextEncoder();
		const body = () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`event: work\ndata: ${JSON.stringify({
								type: 'work',
								unread_messages: 0,
								open_tasks: 0,
								pending_approvals: 0,
								at: new Date().toISOString()
							})}\n\n`
						)
					);
					controller.close();
				}
			});

		await runMonitor({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['*'],
			write: (line) => written.push(line),
			log: () => {},
			fetch: vi.fn(() =>
				Promise.resolve(new Response(body(), { status: 200 }))
			) as unknown as typeof globalThis.fetch,
			sleep: async () => {
				// Two connections, then stop: the second must not announce itself.
				if (++call >= 2) abort.abort();
			},
			signal: abort.signal
		});

		expect(written.filter((line) => line.includes('connected'))).toHaveLength(1);
	});
});
