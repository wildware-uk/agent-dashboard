import { beforeEach, describe, expect, it } from 'vitest';
import { Threads, type ThreadsOptions } from './threads.svelte';
import { FakeStream, aMessage, fakeMessagesApi } from './testing';

/**
 * The thread store, driven the way the server drives it: a read, then events.
 *
 * The acceptance criterion this file exists for is the last one in #14 — an
 * owner reply appears in the thread with no reload — and it is proven the way
 * the transport actually works (design §4): the write publishes, the frame
 * arrives, the store refetches and reconciles. Nothing here inserts a message
 * optimistically, because nothing in production does.
 */

const onCard = aMessage({ id: 'm1', seq: 5, updateId: 'u1', body: 'nice one' });
const onOther = aMessage({ id: 'm2', seq: 6, updateId: 'u2', body: 'and this' });

let api: ReturnType<typeof fakeMessagesApi>;
let stream: FakeStream;

function threads(options: Partial<ThreadsOptions> = {}) {
	stream = new FakeStream();
	return new Threads({
		fetch: api.fetch,
		openStream: (url) => {
			stream.url = url;
			return stream;
		},
		schedule: (run) => api.queue.push(run),
		...options
	});
}

/** One `message.created`, exactly as the server serialises it. */
function published(message: { id: string; seq: number }) {
	stream.emit('message.created', {
		seq: message.seq,
		payload: { messageId: message.id, projectId: 'p1', author: 'human' }
	});
}

beforeEach(() => {
	api = fakeMessagesApi({ seq: 6, messages: [onCard, onOther] });
});

describe('reading the threads on a page', () => {
	it('reads every thread in one request rather than one per card', async () => {
		const store = threads();
		store.start();
		await api.settle();

		expect(api.calls).toEqual(['/api/messages']);
		expect(store.messages).toHaveLength(2);
	});

	it('scopes the request to the project the page is showing', async () => {
		const store = threads({ project: 'agent-dashboard' });
		store.start();
		await api.settle();

		expect(api.calls).toEqual(['/api/messages?project=agent-dashboard']);
	});

	it('hands each card only its own thread, oldest first', async () => {
		const store = threads();
		store.start();
		await api.settle();

		expect(store.for('u1').map((message) => message.id)).toEqual(['m1']);
		expect(store.for('u2').map((message) => message.id)).toEqual(['m2']);
		expect(store.for('u3')).toEqual([]);
	});

	it('adopts a snapshot it was handed without asking for another', () => {
		const store = threads();

		store.hydrate(api.snapshot());

		expect(store.for('u1')).toHaveLength(1);
		expect(store.seq).toBe(6);
		expect(api.calls).toEqual([]);
	});
});

describe('a reply arriving live', () => {
	it('appears in the thread on message.created, with no reload', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();
		await api.settle();

		const reply = aMessage({ id: 'm3', seq: 7, updateId: 'u1', body: 'thanks' });
		api.publish(reply);
		published(reply);
		await api.settle();

		expect(store.for('u1').map((message) => message.body)).toEqual(['nice one', 'thanks']);
	});

	it('coalesces a burst of arrivals into one request', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();

		for (const seq of [7, 8, 9]) published({ id: `m${seq}`, seq });
		await api.settle();

		expect(api.calls).toEqual(['/api/messages']);
	});

	it('drops a frame the state it holds already accounts for', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();

		// A replayed frame after a reconnect: at or below the snapshot's seq.
		published({ id: 'm1', seq: 5 });
		await api.settle();

		expect(api.calls).toEqual([]);
	});

	it('rereads everything on a resync, which is what a resync means', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();

		stream.emit('resync', { seq: 3 });
		await api.settle();

		expect(api.calls).toEqual(['/api/messages']);
	});

	it('ignores the events that are not its business', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();

		stream.emit('update.created', { seq: 9, payload: { updateId: 'u9' } });
		await api.settle();

		expect(api.calls).toEqual([]);
	});
});

describe('the connection', () => {
	it('resumes from the seq the state it holds is good to', () => {
		const store = threads();
		store.hydrate(api.snapshot());

		store.start();

		expect(stream.url).toBe('/api/stream?last_event_id=6');
		expect(store.status).toBe('live');
	});

	it('lets go on stop, and drops a refetch queued before it', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();
		published({ id: 'm3', seq: 7 });

		store.stop();
		await api.settle();

		expect(api.calls).toEqual([]);
		expect(store.status).toBe('idle');
		expect(stream.listeners).toBe(0);
	});

	it('keeps the thread it holds when a read fails, rather than emptying it', async () => {
		const store = threads();
		store.hydrate(api.snapshot());
		store.start();
		api.breaks(500);

		published({ id: 'm3', seq: 7 });
		await api.settle();

		expect(store.for('u1')).toHaveLength(1);
		expect(store.status).toBe('offline');
	});
});
