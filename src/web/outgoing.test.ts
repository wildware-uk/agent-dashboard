import { beforeEach, describe, expect, it } from 'vitest';
import { ownerActions } from './actions';
import { OutgoingMessages } from './outgoing';
import { Threads } from './threads.svelte';
import { FakeStream, aMessage, fakeMessagesApi } from './testing';

/**
 * The owner's own words show the moment they are sent, not when the stream
 * echoes them back. The stream is the slow path: a laptop just woken, or a tab
 * the browser throttled, can hold a dead connection for a while, and the owner
 * used to have to reload to see their own reply.
 */

const post = aMessage({ id: 'p1', seq: 5, updateId: null, body: 'A post' });

let api: ReturnType<typeof fakeMessagesApi>;
let outgoing: OutgoingMessages;

function threads(project: string | null = null) {
	const stream = new FakeStream();
	return new Threads({
		project,
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run),
		outgoing
	});
}

function jsonReply(status: number, body: unknown) {
	return () =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			})
		);
}

beforeEach(() => {
	api = fakeMessagesApi({ seq: 6, messages: [post] });
	outgoing = new OutgoingMessages();
});

describe('a reply the owner sends', () => {
	it('shows under its post at once, marked as sending', async () => {
		const store = threads();
		store.start();
		await api.settle();

		outgoing.begin({ replyTo: 'p1', body: 'On my way' });

		const [line] = store.repliesTo('p1');
		expect(line.body).toBe('On my way');
		expect(line.author).toBe('human');
		expect(store.isSending(line.id)).toBe(true);
	});

	it('is replaced by the stored message as soon as the send answers, with no read', async () => {
		const store = threads();
		store.start();
		await api.settle();
		const reads = api.calls.length;
		const stored = aMessage({ id: 'm9', seq: 7, updateId: null, replyTo: 'p1', body: 'On my way' });

		const ticket = outgoing.begin({ replyTo: 'p1', body: 'On my way' });
		outgoing.sent(ticket, stored);

		expect(store.repliesTo('p1').map((m) => m.id)).toEqual(['m9']);
		expect(store.isSending('m9')).toBe(false);
		expect(api.calls.length).toBe(reads);
	});

	it('goes away again when the send fails', async () => {
		const store = threads();
		store.start();
		await api.settle();

		const ticket = outgoing.begin({ update: 'u1', body: 'lost' });
		outgoing.failed(ticket);

		expect(store.for('u1')).toEqual([]);
	});

	it('survives a read that left before it was sent, and is not doubled by one after', async () => {
		const store = threads();
		store.start();
		await api.settle();
		const stored = aMessage({ id: 'm9', seq: 7, updateId: 'u1', body: 'sent' });

		// A read is on its way when the send lands: its answer predates the reply.
		const read = store.refresh();
		outgoing.sent(outgoing.begin({ update: 'u1', body: 'sent' }), stored);
		await read;
		expect(store.for('u1').map((m) => m.id)).toEqual(['m9']);

		// The server has it now; the next read includes it, once.
		api.publish(stored);
		await store.refresh();
		expect(store.for('u1').map((m) => m.id)).toEqual(['m9']);
	});

	it('is let go by a read that started after it, so one the server dropped does not linger', async () => {
		const store = threads();
		store.start();
		await api.settle();
		outgoing.sent(
			outgoing.begin({ update: 'u1', body: 'gone' }),
			aMessage({ id: 'm9', seq: 7, updateId: 'u1', body: 'gone' })
		);

		await store.refresh();

		expect(store.for('u1')).toEqual([]);
	});

	it('stops being heard once the page lets the store go', async () => {
		const store = threads();
		store.start();
		await api.settle();
		store.stop();

		outgoing.begin({ replyTo: 'p1', body: 'after' });

		expect(store.repliesTo('p1')).toEqual([]);
	});
});

describe('the owner actions announce every message they send', () => {
	it('says it is sending, then hands over what the server stored', async () => {
		const stored = aMessage({ id: 'm9', seq: 7, updateId: 'u1', body: 'hi' });
		const heard: string[] = [];
		outgoing.listen({
			sending: (ticket) => heard.push(`sending ${ticket.input.body}`),
			sent: (_, message) => heard.push(`sent ${message.id}`),
			failed: () => heard.push('failed')
		});

		await ownerActions(jsonReply(201, { message: stored }), outgoing).postMessage({
			update: 'u1',
			body: 'hi'
		});

		expect(heard).toEqual(['sending hi', 'sent m9']);
	});

	it('says so when the server refuses it', async () => {
		const heard: string[] = [];
		outgoing.listen({
			sending: () => heard.push('sending'),
			sent: () => {},
			failed: () => heard.push('failed')
		});

		await expect(
			ownerActions(
				jsonReply(400, { error: 'invalid_argument', message: 'no' }),
				outgoing
			).postMessage({
				update: 'u1',
				body: ''
			})
		).rejects.toThrow();

		expect(heard).toEqual(['sending', 'failed']);
	});
});
