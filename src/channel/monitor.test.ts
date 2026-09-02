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

		expect(written).toEqual(['Waiting for you on the dashboard: 2 open tasks.']);
	});

	it('says nothing about a count that fell', async () => {
		// Clearing your own inbox is not news, and interrupting an agent to tell it
		// so is how a notification stream teaches its reader to ignore it. The
		// first frame is the baseline the stream opens with.
		const { written } = await monitor([work({}), work({ open_tasks: 2 }), work({ open_tasks: 0 })]);

		expect(written).toHaveLength(1);
	});

	it('asks for the same stream the channel does, with the same subscription', async () => {
		const { fetcher } = await monitor([work({})]);

		expect(fetcher.mock.calls[0]?.[0]).toBe('https://dash.test/api/agent/stream?project=*');
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
			projects: ['one', 'two']
		});
	});

	it('falls back to the file the hook wrote', () => {
		const found = readConnection(
			{ CLAUDE_PLUGIN_DATA: '/data' },
			file('{"url":"https://dash.test","token":"a-token","projects":"*"}') as never
		);

		expect(found).toEqual({ baseUrl: 'https://dash.test', token: 'a-token', projects: ['*'] });
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
