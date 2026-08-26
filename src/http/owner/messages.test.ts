import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listThread, postMessage, postUpdate } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { listMessagesHandler, postMessageHandler, type OwnerHandler } from './messages';

/**
 * The owner's half of messages (design §7): the reply box's endpoint, and the
 * thread the card renders. Everything below the browser is real — one domain,
 * one in-memory database — so what is under test is the join between an HTTP
 * request and the rule that answers it.
 */

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
let agentId: string;
let slug: string;
let updateId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
	updateId = postUpdate(h, { project: slug, agentId, body: 'shipped it' }).id;
});

type CallOptions = {
	body?: unknown;
	query?: Record<string, string>;
	/** Signed session by default; pass `null` for a caller with no cookie. */
	cookie?: string | null;
	raw?: string;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({ ctx: () => h, config, bus: h.bus });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const url = new URL('http://dash.test/api/messages');
	for (const [key, value] of Object.entries(options.query ?? {})) {
		url.searchParams.set(key, value);
	}

	const init: RequestInit = { method: options.body || options.raw ? 'POST' : 'GET' };
	if (options.raw !== undefined) init.body = options.raw;
	else if (options.body !== undefined) init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request(url, init),
		params: {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { status: response.status, body: (await response.json()) as Record<string, never> };
}

describe('POST /api/messages', () => {
	it('posts the owner’s reply on an update, as the literal human', async () => {
		const { status, body } = await call(postMessageHandler, {
			body: { update: updateId, body: 'nice one' }
		});

		expect(status).toBe(201);
		expect(body.message).toMatchObject({ author: 'human', body: 'nice one', updateId });
		expect(listThread(h, { updateId }).map((message) => message.body)).toEqual(['nice one']);
	});

	it('publishes message.created, so every open tab hears about it', async () => {
		await call(postMessageHandler, { body: { update: updateId, body: 'nice one' } });

		expect(h.eventNames().at(-1)).toBe('message.created');
	});

	it('takes a project or a task as the scope instead', async () => {
		const project = await call(postMessageHandler, { body: { project: slug, body: 'stand by' } });

		expect(project.status).toBe(201);
		expect(project.body.message).toMatchObject({ updateId: null, taskId: null });
	});

	it('refuses a caller with no session, and never writes anything', async () => {
		const { status, body } = await call(postMessageHandler, {
			body: { update: updateId, body: 'nice one' },
			cookie: null
		});

		expect(status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
		expect(listThread(h, { updateId })).toEqual([]);
	});

	it('maps a refusal onto its status: 400 for a blank body, 404 for a missing update', async () => {
		await expect(
			call(postMessageHandler, { body: { update: updateId, body: '  ' } })
		).resolves.toMatchObject({ status: 400, body: { error: 'invalid_argument' } });
		await expect(
			call(postMessageHandler, { body: { update: 'gone', body: 'hello' } })
		).resolves.toMatchObject({ status: 404, body: { error: 'not_found' } });
	});

	it('refuses a body that is not a JSON object, and one with no text at all', async () => {
		await expect(call(postMessageHandler, { raw: 'body=hi' })).resolves.toMatchObject({
			status: 400
		});
		await expect(call(postMessageHandler, { body: { update: updateId } })).resolves.toMatchObject({
			status: 400
		});
	});

	it('drops a field only the server gets to decide, rather than writing it', async () => {
		const { body } = await call(postMessageHandler, {
			body: { update: updateId, body: 'nice one', author: 'agent:someone-else', id: 'chosen' }
		});

		expect(body.message).toMatchObject({ author: 'human' });
		expect((body.message as unknown as { id: string }).id).not.toBe('chosen');
	});
});

describe('GET /api/messages', () => {
	beforeEach(() => {
		postMessage(h, { author: { kind: 'human' }, body: 'on the card', updateId });
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'thanks', updateId });
		postMessage(h, { author: { kind: 'human' }, body: 'on the project', project: slug });
	});

	it('answers one update’s thread, oldest first, stamped with the stream cursor', async () => {
		const { status, body } = await call(listMessagesHandler, { query: { update: updateId } });

		expect(status).toBe(200);
		expect((body.messages as unknown as { body: string }[]).map((m) => m.body)).toEqual([
			'on the card',
			'thanks'
		]);
		expect(body.seq).toBe(h.bus.lastSeq);
		expect(typeof body.at).toBe('string');
	});

	it('answers a whole project, so one request carries every card’s thread', async () => {
		const { body } = await call(listMessagesHandler, { query: { project: slug } });

		expect((body.messages as unknown as { body: string }[]).map((m) => m.body)).toEqual([
			'on the card',
			'thanks',
			'on the project'
		]);
	});

	it('answers every message when no scope is given', async () => {
		const { body } = await call(listMessagesHandler);

		expect(body.messages).toHaveLength(3);
	});

	it('refuses a caller with no session', async () => {
		const { status, body } = await call(listMessagesHandler, { cookie: null });

		expect(status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
	});

	it('maps an unknown project onto a 404, and a bad limit onto a 400', async () => {
		await expect(call(listMessagesHandler, { query: { project: 'nope' } })).resolves.toMatchObject({
			status: 404
		});
		await expect(call(listMessagesHandler, { query: { limit: 'lots' } })).resolves.toMatchObject({
			status: 400
		});
	});

	it('is not cacheable: a thread is state, not an asset', async () => {
		const handler = listMessagesHandler({ ctx: () => h, config, bus: h.bus });
		const url = new URL('http://dash.test/api/messages');
		const response = await handler({
			request: new Request(url),
			params: {},
			cookies: { get: () => signSession(SESSION_SECRET) }
		});

		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
