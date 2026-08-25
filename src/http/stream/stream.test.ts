import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type AppEvent, type EventBus as Bus } from '$events';
import { SESSION_COOKIE, signSession } from '../auth';
import { HEARTBEAT_MS, createStreamHandler } from './stream';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

/** One parsed SSE frame. Fields absent from the frame stay undefined. */
type Frame = { id?: number; event?: string; data?: unknown; comment?: string; retry?: number };

function parseFrames(text: string): Frame[] {
	return text
		.split('\n\n')
		.filter((block) => block.trim().length > 0)
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split('\n')) {
				if (line.startsWith(': ')) frame.comment = line.slice(2);
				else if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
				else if (line.startsWith('event: ')) frame.event = line.slice(7);
				else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7));
				else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
			}
			return frame;
		});
}

type ConnectOptions = {
	lastEventId?: string | number;
	query?: string;
	heartbeatMs?: number;
	cookie?: string;
};

/**
 * Open the stream the way SvelteKit would, and read frames off it.
 *
 * Every write is a synchronous enqueue, so `take(n)` is deterministic: it reads
 * chunks until it has n frames, never waiting on a timer.
 */
function connect(bus: Bus, options: ConnectOptions = {}) {
	const handler = createStreamHandler({
		bus,
		config,
		heartbeatMs: options.heartbeatMs ?? 0
	});
	const abort = new AbortController();
	const headers = new Headers();
	if (options.lastEventId !== undefined) {
		headers.set('last-event-id', String(options.lastEventId));
	}
	const url = new URL(`http://dash.test/api/stream${options.query ?? ''}`);
	const cookie = options.cookie ?? signSession(SESSION_SECRET);
	const response = handler({
		request: new Request(url, { headers, signal: abort.signal }),
		url,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	});

	const reader = response.body?.getReader();
	const decoder = new TextDecoder();
	let pending: Frame[] = [];

	return {
		response,
		abort: () => abort.abort(),
		cancel: () => reader!.cancel(),
		/** The next n frames, reading more chunks only when the buffer is short. */
		async take(n: number): Promise<Frame[]> {
			while (pending.length < n) {
				const { value, done } = await reader!.read();
				if (done) break;
				pending = [...pending, ...parseFrames(decoder.decode(value))];
			}
			const taken = pending.slice(0, n);
			pending = pending.slice(n);
			return taken;
		},
		/** The preamble every connection opens with: a retry hint and a comment. */
		async preamble(): Promise<Frame[]> {
			return this.take(2);
		}
	};
}

function publish(bus: Bus, projectId: string): AppEvent {
	return bus.publish('project.created', { projectId, slug: projectId });
}

afterEach(() => {
	vi.useRealTimers();
});

describe('a live connection', () => {
	it('answers with the SSE content type and asks proxies not to buffer', async () => {
		const client = connect(new EventBus());

		expect(client.response.status).toBe(200);
		expect(client.response.headers.get('content-type')).toMatch(/^text\/event-stream\b/);
		expect(client.response.headers.get('x-accel-buffering')).toBe('no');
		client.abort();
	});

	it('opens with a reconnect hint, so a dropped client backs off predictably', async () => {
		const client = connect(new EventBus());

		const [retry, comment] = await client.preamble();

		expect(retry.retry).toBeGreaterThan(0);
		expect(comment.comment).toBeDefined();
		client.abort();
	});

	it('receives an event published after it connected, tagged with the global seq', async () => {
		const bus = new EventBus();
		const client = connect(bus);
		await client.preamble();

		const published = publish(bus, 'p1');
		const [frame] = await client.take(1);

		expect(frame.event).toBe('project.created');
		expect(frame.id).toBe(published.seq);
		expect(frame.data).toEqual(published);
		client.abort();
	});

	it('fans one event out to every connected client', async () => {
		const bus = new EventBus();
		const first = connect(bus);
		const second = connect(bus);
		await first.preamble();
		await second.preamble();

		publish(bus, 'p1');

		expect((await first.take(1))[0].event).toBe('project.created');
		expect((await second.take(1))[0].event).toBe('project.created');
		first.abort();
		second.abort();
	});
});

describe('reconnecting with a Last-Event-ID still in the buffer', () => {
	it('replays exactly the missed events, in order, with no duplicates', async () => {
		const bus = new EventBus();
		const first = publish(bus, 'p1');
		const second = publish(bus, 'p2');
		const third = publish(bus, 'p3');

		const client = connect(bus, { lastEventId: first.seq });
		await client.preamble();
		const replayed = await client.take(2);
		const live = publish(bus, 'p4');
		const [next] = await client.take(1);

		expect(replayed.map((frame) => frame.id)).toEqual([second.seq, third.seq]);
		expect(next.id).toBe(live.seq);
		client.abort();
	});

	it('replays nothing for a client that is already up to date', async () => {
		const bus = new EventBus();
		publish(bus, 'p1');
		const latest = publish(bus, 'p2');

		const client = connect(bus, { lastEventId: latest.seq });
		await client.preamble();
		const live = publish(bus, 'p3');
		const [frame] = await client.take(1);

		// The first frame after the preamble is the new event, not a replay of one
		// the client already has.
		expect(frame.id).toBe(live.seq);
		client.abort();
	});

	it('takes the cursor from the query string too, for a hand-rolled reconnect', async () => {
		const bus = new EventBus();
		const first = publish(bus, 'p1');
		const second = publish(bus, 'p2');

		const client = connect(bus, { query: `?last_event_id=${first.seq}` });
		await client.preamble();

		expect((await client.take(1))[0].id).toBe(second.seq);
		client.abort();
	});

	it('ignores a cursor that is not a sequence number and starts live', async () => {
		const bus = new EventBus();
		publish(bus, 'p1');

		const client = connect(bus, { lastEventId: 'not-a-number' });
		await client.preamble();
		const live = publish(bus, 'p2');

		expect((await client.take(1))[0].id).toBe(live.seq);
		client.abort();
	});
});

describe('reconnecting with a Last-Event-ID the buffer can no longer serve', () => {
	it('emits one resync and nothing else, then carries on live', async () => {
		// Capacity 2 retains seqs 3 and 4, so a cursor of 1 leaves a hole at 2 that
		// no replay can fill: that is the case the design answers with `resync`.
		const bus = new EventBus({ capacity: 2 });
		publish(bus, 'p1');
		publish(bus, 'p2');
		publish(bus, 'p3');
		publish(bus, 'p4');

		const client = connect(bus, { lastEventId: 1 });
		await client.preamble();
		const [resync] = await client.take(1);
		const live = publish(bus, 'p5');
		const [after] = await client.take(1);

		expect(resync.event).toBe('resync');
		expect(resync.data).toMatchObject({ type: 'resync', reason: 'expired', from: 1, seq: 4 });
		expect(resync.id).toBe(4);
		// Exactly one resync: the next frame is the live event, not a second one.
		expect(after.id).toBe(live.seq);
		expect(after.event).toBe('project.created');
		client.abort();
	});

	it('resyncs a cursor from before a restart, which is ahead of this process', async () => {
		const bus = new EventBus();
		publish(bus, 'p1');

		const client = connect(bus, { lastEventId: 4096 });
		await client.preamble();
		const [resync] = await client.take(1);

		expect(resync.event).toBe('resync');
		expect(resync.data).toMatchObject({ reason: 'ahead', from: 4096, seq: 1 });
		client.abort();
	});
});

describe('keeping the connection alive', () => {
	it('writes a comment frame every heartbeat interval', async () => {
		vi.useFakeTimers();
		const bus = new EventBus();
		const client = connect(bus, { heartbeatMs: HEARTBEAT_MS });
		await client.preamble();

		vi.advanceTimersByTime(HEARTBEAT_MS);
		const [beat] = await client.take(1);

		expect(beat.comment).toContain('heartbeat');
		expect(beat.event).toBeUndefined();
		client.abort();
	});
});

describe('disconnecting', () => {
	it('removes the subscription when the request is aborted', async () => {
		const bus = new EventBus();
		const client = connect(bus);
		await client.preamble();
		expect(bus.listenerCount).toBe(1);

		client.abort();

		expect(bus.listenerCount).toBe(0);
	});

	it('removes the subscription when the browser cancels the body', async () => {
		const bus = new EventBus();
		const client = connect(bus);
		await client.preamble();
		expect(bus.listenerCount).toBe(1);

		await client.cancel();

		expect(bus.listenerCount).toBe(0);
	});

	it('leaves other clients subscribed', async () => {
		const bus = new EventBus();
		const first = connect(bus);
		const second = connect(bus);
		await first.preamble();
		await second.preamble();

		first.abort();

		expect(bus.listenerCount).toBe(1);
		second.abort();
		expect(bus.listenerCount).toBe(0);
	});

	it('stops the heartbeat timer, so a closed connection leaves nothing running', async () => {
		vi.useFakeTimers();
		const bus = new EventBus();
		const client = connect(bus, { heartbeatMs: HEARTBEAT_MS });
		await client.preamble();
		expect(vi.getTimerCount()).toBe(1);

		client.abort();

		expect(vi.getTimerCount()).toBe(0);
		expect(bus.listenerCount).toBe(0);
	});

	it('tears down when the request was already aborted before the stream started', async () => {
		const bus = new EventBus();
		const abort = new AbortController();
		abort.abort();
		const handler = createStreamHandler({ bus, config, heartbeatMs: HEARTBEAT_MS });
		const url = new URL('http://dash.test/api/stream');

		handler({
			request: new Request(url, { signal: abort.signal }),
			url,
			cookies: { get: () => signSession(SESSION_SECRET) }
		});

		expect(bus.listenerCount).toBe(0);
	});
});

describe('an unauthenticated request', () => {
	it('is refused with 401 and never subscribes to the bus', async () => {
		const bus = new EventBus();
		const client = connect(bus, { cookie: '' });

		expect(client.response.status).toBe(401);
		expect(client.response.headers.get('content-type')).toBe('application/json');
		expect(bus.listenerCount).toBe(0);
	});
});
