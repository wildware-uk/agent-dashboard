import { describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CAPABILITIES,
	CHANNEL_NAME,
	INSTRUCTIONS,
	createChannelServer,
	describeRise,
	main,
	readFrames,
	runBridge,
	type ChannelMessage,
	type Work
} from './index';

/**
 * The bridge between the dashboard and a Claude Code session (design §5).
 *
 * The thing worth testing here is restraint. A channel writes straight into a
 * working agent's context, so every notification costs it a turn: the rules
 * about what is *not* said are the product, and the transport is the easy half.
 */

const work = (overrides: Partial<Work> = {}): Work => ({
	unread_messages: 0,
	open_tasks: 0,
	pending_approvals: 0,
	...overrides
});

/** An SSE body, as the dashboard writes one. */
function sse(...frames: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		}
	});
}

/** An `event: message` frame, as the dashboard sends one after a rise. */
function messageFrame(...messages: Partial<ChannelMessage>[]): string {
	const full = messages.map((message) => ({
		message_id: 'm1',
		project_id: 'p1',
		project: 'agent-dashboard',
		project_name: 'Agent Dashboard',
		update_id: 'u1',
		task_id: null,
		author: 'human',
		body: 'have a look at this',
		created_at: '2026-08-31T00:00:00.000Z',
		...message
	}));
	return `event: message\ndata: ${JSON.stringify({ type: 'message', messages: full })}\n\n`;
}

function workFrame(counts: Partial<Work>): string {
	return `event: work\ndata: ${JSON.stringify({ type: 'work', ...work(counts), at: '2026-08-31T00:00:00.000Z' })}\n\n`;
}

describe('the channel it declares itself to be', () => {
	it('declares the capability that makes Claude Code register a listener', () => {
		// Without this exact key the process is an ordinary MCP server and every
		// notification it sends is dropped in silence.
		expect(CAPABILITIES).toMatchObject({ experimental: { 'claude/channel': {} } });
		expect(createChannelServer()).toBeInstanceOf(Server);
	});

	it('offers no tools, because the dashboard already has them all', () => {
		// A reply tool here would be a second `post_update` over a second
		// transport, and the two would drift.
		expect(CAPABILITIES).not.toHaveProperty('tools');
	});

	it('does not offer permission relay, which it has no standing to gate', () => {
		expect(CAPABILITIES.experimental).not.toHaveProperty('claude/channel/permission');
	});

	it('tells Claude which tool answers each count', () => {
		// The counts are useless without this: an agent told "you have messages"
		// and left to guess the tool spends a turn guessing.
		expect(INSTRUCTIONS).toContain('get_messages');
		expect(INSTRUCTIONS).toContain('list_tasks');
		expect(INSTRUCTIONS).toContain('await_request');
	});

	it('does not promise a source attribute it does not control', () => {
		// Claude Code sets `source` from the MCP config entry name, not from this
		// server's `name`. Naming a specific value would send agents looking for a
		// tag that never arrives — as the first live run showed.
		expect(INSTRUCTIONS).not.toContain(`source="${CHANNEL_NAME}"`);
		expect(INSTRUCTIONS).toContain('source attribute is the name');
	});
});

describe('what is worth interrupting an agent for', () => {
	it('announces work on the first frame that has any', () => {
		expect(describeRise(null, work({ unread_messages: 2 }))).toBe(
			'Waiting for you on the dashboard: 2 unread messages from your owner.'
		);
	});

	it('says nothing at all when there is nothing waiting', () => {
		expect(describeRise(null, work())).toBeNull();
	});

	it('stays quiet when a count falls, which is the agent clearing its own inbox', () => {
		// The agent called get_messages and the count dropped. Telling it so would
		// interrupt it to report its own action.
		expect(describeRise(work({ unread_messages: 3 }), work({ unread_messages: 0 }))).toBeNull();
		expect(describeRise(work({ open_tasks: 2 }), work({ open_tasks: 1 }))).toBeNull();
	});

	it('mentions only the count that rose, not the ones that stood still', () => {
		const sentence = describeRise(
			work({ unread_messages: 1, open_tasks: 4 }),
			work({ unread_messages: 1, open_tasks: 5 })
		);

		expect(sentence).toBe('Waiting for you on the dashboard: 5 open tasks.');
		expect(sentence).not.toContain('message');
	});

	it('reads as English for one of a thing', () => {
		expect(describeRise(null, work({ open_tasks: 1 }))).toContain('1 open task.');
		expect(describeRise(null, work({ pending_approvals: 1 }))).toContain(
			'1 request still waiting on your owner'
		);
	});

	it('gathers several rises into one sentence rather than several notifications', () => {
		expect(describeRise(null, work({ unread_messages: 1, open_tasks: 2 }))).toBe(
			'Waiting for you on the dashboard: 1 unread message from your owner, 2 open tasks.'
		);
	});
});

describe('reading the stream', () => {
	it('parses frames as they arrive and skips the heartbeat comments', async () => {
		const frames = [];
		for await (const frame of readFrames(
			sse('retry: 2000\n\n', ': connected\n\n', workFrame({ open_tasks: 1 }))
		)) {
			frames.push(frame);
		}

		// The comment carries no field name, so it is not a frame anybody handles.
		expect(frames).toHaveLength(2);
		expect(frames[0]).toEqual({ retry: '2000' });
		expect(frames[1]?.event).toBe('work');
	});

	it('handles a frame split across two chunks, which a socket will do', async () => {
		const full = workFrame({ unread_messages: 1 });
		const frames = [];
		for await (const frame of readFrames(sse(full.slice(0, 20), full.slice(20)))) {
			frames.push(frame);
		}

		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0]!.data!)).toMatchObject({ unread_messages: 1 });
	});
});

describe('pushing into the session', () => {
	/** Run the bridge over one canned response, then stop it. */
	async function bridge(body: ReadableStream<Uint8Array>, options: { status?: number } = {}) {
		const notify = vi.fn().mockResolvedValue(undefined);
		const abort = new AbortController();
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(body, { status: options.status ?? 200 }));

		await runBridge({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			// Every session states its scope now, so the harness states the widest
			// one rather than leaving it out.
			projects: ['*'],
			fetch: fetcher as unknown as typeof globalThis.fetch,
			notify,
			// The loop reconnects for ever; aborting during the first backoff is how
			// a test gets one pass and then stops.
			sleep: async () => abort.abort(),
			signal: abort.signal
		});

		return { notify, fetcher };
	}

	it('sends the message itself, not just that one exists', async () => {
		const { notify } = await bridge(
			sse(workFrame({ unread_messages: 1 }), messageFrame({ body: 'try the other branch' }))
		);

		// One notification, carrying the text: an agent told only "1 unread" has to
		// spend a tool call before it knows whether the message concerns it.
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toBe('Your owner on Agent Dashboard: try the other branch');
	});

	it('puts every id needed to reply on the tag', async () => {
		const { notify } = await bridge(
			sse(workFrame({ unread_messages: 1 }), messageFrame({ update_id: 'u9' }))
		);

		// `post_message` takes update_id verbatim, so a reply needs no lookup.
		expect(notify.mock.calls[0]?.[1]).toMatchObject({
			message_id: 'm1',
			project: 'agent-dashboard',
			project_id: 'p1',
			update_id: 'u9'
		});
	});

	it('carries the counts as meta for work with no message behind it', async () => {
		const { notify } = await bridge(sse(workFrame({ open_tasks: 3 })));

		// Strings, because a channel's meta values are attributes on the tag.
		expect(notify.mock.calls[0]?.[1]).toEqual({
			unread_messages: '0',
			open_tasks: '3',
			pending_approvals: '0'
		});
	});

	it('still speaks up when the message frame never arrives', async () => {
		// The connection dropped between the counts and the text. Better a
		// notification without the message than silence about waiting work.
		const { notify } = await bridge(sse(workFrame({ unread_messages: 1 })));

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain('1 unread message');
	});

	it('subscribes to the projects this session is for', async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const abort = new AbortController();
		const fetcher = vi.fn().mockResolvedValue(new Response(sse(workFrame({})), { status: 200 }));

		await runBridge({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['megamerge-mod-engine', 'melon-merge'],
			fetch: fetcher as unknown as typeof globalThis.fetch,
			notify,
			sleep: async () => abort.abort(),
			signal: abort.signal
		});

		// One parameter per project rather than a joined string: the dashboard
		// accepts either, and repeated keys need no escaping rules.
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			'https://dash.test/api/agent/stream?project=megamerge-mod-engine&project=melon-merge'
		);
	});

	it('sends the agent its token and asks for the stream', async () => {
		const { fetcher } = await bridge(sse(workFrame({})));

		// `*` on the wire, because a subscription is now always stated: the widest
		// one is a thing somebody typed rather than the absence of a setting.
		expect(fetcher.mock.calls[0]?.[0]).toBe('https://dash.test/api/agent/stream?project=*');
		expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: 'Bearer a-token',
			accept: 'text/event-stream'
		});
	});

	/**
	 * The sequence that went quiet on the first live run.
	 *
	 * Told about work, the agent reads it and the count falls to zero; a new
	 * message then arrives. That last frame is lower than the *first* one, and
	 * suppressing it because of that is precisely the bug: the fall to zero is
	 * what makes the rise from zero real. It only works because the dashboard now
	 * publishes the read (`messages.read`), so the fall is a frame at all.
	 */
	it('announces new work after the agent has cleared its inbox', async () => {
		const { notify } = await bridge(
			sse(
				workFrame({ unread_messages: 2 }),
				messageFrame({ message_id: 'm1', body: 'first' }, { message_id: 'm2', body: 'second' }),
				// the agent called get_messages
				workFrame({ unread_messages: 0 }),
				// and then the owner replied again
				workFrame({ unread_messages: 1 }),
				messageFrame({ message_id: 'm3', body: 'third' })
			)
		);

		expect(notify.mock.calls.map((call) => call[0])).toEqual([
			'Your owner on Agent Dashboard: first',
			'Your owner on Agent Dashboard: second',
			'Your owner on Agent Dashboard: third'
		]);
	});

	it('says nothing for the opening frame of a dashboard with no work', async () => {
		const { notify } = await bridge(sse(workFrame({})));

		expect(notify).not.toHaveBeenCalled();
	});

	it('survives a malformed frame rather than dropping the connection', async () => {
		const { notify } = await bridge(
			sse('event: message\ndata: {not json\n\n', workFrame({ open_tasks: 1 }))
		);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain('1 open task');
	});

	it('does not throw when the dashboard refuses the token', async () => {
		// A bad token is not a reason to take the channel down for the rest of the
		// session: the owner may be re-minting one.
		const { notify } = await bridge(sse(), { status: 401 });

		expect(notify).not.toHaveBeenCalled();
	});

	it('stops when its signal is aborted rather than reconnecting for ever', async () => {
		const abort = new AbortController();
		abort.abort();
		const fetcher = vi.fn();

		await runBridge({
			baseUrl: 'https://dash.test',
			token: 'a-token',
			projects: ['*'],
			fetch: fetcher as unknown as typeof globalThis.fetch,
			notify: vi.fn(),
			signal: abort.signal
		});

		expect(fetcher).not.toHaveBeenCalled();
	});
});

/**
 * Starting up: what the bridge refuses to guess.
 *
 * `AGENT_DASHBOARD_PROJECTS` used to be optional, and an unset one meant "work
 * it out from what this agent has done" — which made the commonest
 * configuration the one nobody had chosen, and let a session's scope accumulate
 * out of its own history rather than being decided by whoever set it up. It is
 * now required, and `*` is how you say "all of them" on purpose.
 */
describe('what main needs before it will start', () => {
	function stderr() {
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		return {
			written,
			restore: () => {
				process.stderr.write = original;
			}
		};
	}

	async function start(env: NodeJS.ProcessEnv) {
		const log = stderr();
		const code = process.exitCode;
		try {
			await main(env);
			return { said: log.written.join(''), exitCode: process.exitCode };
		} finally {
			log.restore();
			process.exitCode = code;
		}
	}

	it('refuses to start with no subscription, and says which variable', async () => {
		const { said, exitCode } = await start({
			AGENT_DASHBOARD_URL: 'https://dash.test',
			AGENT_DASHBOARD_TOKEN: 'a-token'
		});

		expect(said).toContain('AGENT_DASHBOARD_PROJECTS');
		expect(exitCode).toBe(1);
	});

	it('treats an empty subscription as no subscription, rather than as everything', async () => {
		const { said, exitCode } = await start({
			AGENT_DASHBOARD_URL: 'https://dash.test',
			AGENT_DASHBOARD_TOKEN: 'a-token',
			AGENT_DASHBOARD_PROJECTS: '  ,  '
		});

		expect(said).toContain('AGENT_DASHBOARD_PROJECTS');
		expect(exitCode).toBe(1);
	});

	it('says how to ask for every project, because that is the case it refuses', async () => {
		const { said } = await start({
			AGENT_DASHBOARD_URL: 'https://dash.test',
			AGENT_DASHBOARD_TOKEN: 'a-token'
		});

		expect(said).toContain('*');
	});

	it('still refuses a missing URL or token first', async () => {
		const { said, exitCode } = await start({ AGENT_DASHBOARD_PROJECTS: '*' });

		expect(said).toContain('AGENT_DASHBOARD_URL');
		expect(exitCode).toBe(1);
	});
});
