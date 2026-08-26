import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listThread, postMessage, postUpdate } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { Threads, ownerActions } from '$web';
import { FakeStream } from '$web/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { listMessagesHandler, postMessageHandler } from './messages';

/**
 * The acceptance criterion this slice exists for: an owner reply appears in the
 * thread live, with no reload — in the tab that sent it *and* in a tab nobody
 * touched.
 *
 * Everything below the browser is real: the domain, the bus, the two endpoints
 * and the client's own `ownerActions` and `Threads`, all against one in-memory
 * database. The two fakes are the two things a Node test cannot have —
 * `EventSource` (the bus is piped into a `FakeStream` per tab, exactly as `GET
 * /api/stream` pipes it into a real one) and the network (`fetch` calls the
 * handlers directly).
 *
 * So what is under test is the join: the reply box posts, the domain publishes,
 * the stream carries it, and the tab that was only watching refetches and agrees.
 */

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });
const cookies = {
	get: (name: string) => (name === SESSION_COOKIE ? signSession(SESSION_SECRET) : undefined)
};

let h: Harness;
let agentId: string;
let updateId: string;
/** Every refetch the tabs have queued, run by hand so the test controls timing. */
let queue: (() => void)[];
let streams: FakeStream[];

/** The network: a request in, one of the two real handlers out. */
function request(url: string, init: RequestInit = {}): Promise<Response> {
	const target = new URL(url, 'http://dash.test');
	const handler =
		(init.method ?? 'GET') === 'GET'
			? listMessagesHandler({ ctx: () => h, config, bus: h.bus })
			: postMessageHandler({ ctx: () => h, config, bus: h.bus });

	return handler({ request: new Request(target, init), params: {}, cookies });
}

/** One open browser tab: a thread store on its own stream, plus the write client. */
function tab() {
	const stream = new FakeStream();
	streams.push(stream);
	const threads = new Threads({
		fetch: (url) => request(url),
		openStream: () => stream,
		schedule: (run) => queue.push(run)
	});
	threads.start();
	return { threads, actions: ownerActions(request) };
}

/** Run every queued refetch and let its promises settle. */
async function settle(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) {
		while (queue.length > 0) queue.shift()!();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	queue = [];
	streams = [];
	// The bus is the only wire between a write and the tabs, so this subscription
	// is the whole SSE fan-out: every published event reaches every open stream.
	h.bus.subscribe((event) => {
		for (const stream of streams) {
			stream.emit(event.type, { seq: event.seq, payload: event.payload });
		}
	});

	createProject(h, { name: 'Agent Dashboard' });
	updateId = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' }).id;
});

describe('two open tabs', () => {
	it('both show a reply typed in one of them, with no reload', async () => {
		const one = tab();
		const two = tab();
		await settle();

		await one.actions.postMessage({ update: updateId, body: 'try the other branch' });
		await settle();

		expect(one.threads.for(updateId).map((message) => message.body)).toEqual([
			'try the other branch'
		]);
		expect(two.threads.for(updateId).map((message) => message.body)).toEqual([
			'try the other branch'
		]);
	});

	it('both show an agent’s answer, which is what makes it a conversation', async () => {
		const one = tab();
		await settle();
		await one.actions.postMessage({ update: updateId, body: 'why?' });
		await settle();

		// The agent replies over its own front door — the domain, as the MCP tool
		// calls it — and the owner's tab hears about it on the same stream.
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'because of the cache', updateId });
		await settle();

		expect(one.threads.for(updateId).map((message) => message.author)).toEqual([
			'human',
			`agent:${agentId}`
		]);
	});

	it('keeps each card’s thread to itself', async () => {
		const other = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'and this' }).id;
		const one = tab();
		await settle();

		await one.actions.postMessage({ update: updateId, body: 'about the first' });
		await one.actions.postMessage({ update: other, body: 'about the second' });
		await settle();

		expect(one.threads.for(updateId).map((message) => message.body)).toEqual(['about the first']);
		expect(one.threads.for(other).map((message) => message.body)).toEqual(['about the second']);
	});

	it('leaves a tab scoped to another project alone', async () => {
		const other = createProject(h, { name: 'Other' }).project;
		const elsewhere = new Threads({
			project: other.slug,
			fetch: (url) => request(url),
			openStream: () => {
				const stream = new FakeStream();
				streams.push(stream);
				return stream;
			},
			schedule: (run) => queue.push(run)
		});
		elsewhere.start();
		const one = tab();
		await settle();

		await one.actions.postMessage({ update: updateId, body: 'not your business' });
		await settle();

		expect(elsewhere.messages).toEqual([]);
		expect(one.threads.for(updateId)).toHaveLength(1);
	});

	it('refuses the write with no session, and no tab shows anything', async () => {
		const one = tab();
		await settle();

		const refused = await request('/api/messages', {
			method: 'POST',
			body: JSON.stringify({ update: updateId, body: 'stranger' }),
			headers: { accept: 'application/json' }
		});
		// The handler is the same one the tab uses; only the cookie is missing.
		const anonymous = await postMessageHandler({ ctx: () => h, config })({
			request: new Request('http://dash.test/api/messages', {
				method: 'POST',
				body: JSON.stringify({ update: updateId, body: 'stranger' })
			}),
			params: {},
			cookies: { get: () => undefined }
		});
		await settle();

		expect(refused.status).toBe(201);
		expect(anonymous.status).toBe(401);
		expect(listThread(h, { updateId })).toHaveLength(1);
		expect(one.threads.for(updateId)).toHaveLength(1);
	});
});
