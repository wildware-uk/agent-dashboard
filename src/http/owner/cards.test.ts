import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, postMessage, postUpdate, reactionsFor, resolveCard } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import {
	pinCardHandler,
	reactToCardHandler,
	setCardStatusHandler,
	type OwnerHandler
} from './index';

/**
 * The owner's writes that work on any card (migration 034).
 *
 * The owner: "let me pin my own messages… they should all share the same
 * features." Pinning used to be a field on `PATCH /api/updates/[id]`, which is
 * why a post could not be pinned at all.
 */
const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
let slug: string;
let postId: string;
let updateId: string;

beforeEach(() => {
	h = harness();
	const agentId = h.agent('scout');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
	updateId = postUpdate(h, { project: slug, agentId, body: 'shipped it' }).id;
	postId = postMessage(h, { author: { kind: 'human' }, project: slug, body: 'have a look' }).id;
});

async function call(
	factory: (options: object) => OwnerHandler,
	path: string,
	params: Record<string, string>,
	body?: unknown,
	cookie: string | null = signSession(SESSION_SECRET)
) {
	const handler = factory({ ctx: () => h, config, bus: h.bus });
	const response = await handler({
		request: new Request(`http://dash.test${path}`, {
			method: 'POST',
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		}),
		params,
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { status: response.status, body: (await response.json()) as Record<string, never> };
}

describe('POST /api/cards/[kind]/[id]/pin', () => {
	it('pins one of the owner`s own posts, which nothing could do before', async () => {
		const { status, body } = await call(
			pinCardHandler,
			`/api/cards/message/${postId}/pin`,
			{ kind: 'message', id: postId },
			{ pinned: true }
		);

		expect(status).toBe(200);
		expect(body).toMatchObject({ pinned: true });
		expect(resolveCard(h, { kind: 'message', id: postId }).pinned).toBe(true);
	});

	it('pins an update through the same route', async () => {
		await call(
			pinCardHandler,
			`/api/cards/update/${updateId}/pin`,
			{ kind: 'update', id: updateId },
			{ pinned: true }
		);

		expect(resolveCard(h, { kind: 'update', id: updateId }).pinned).toBe(true);
	});

	it('refuses a kind that is not one, because it would reach the database', async () => {
		const { status } = await call(
			pinCardHandler,
			'/api/cards/sqlite_master/x/pin',
			{ kind: 'sqlite_master', id: 'x' },
			{ pinned: true }
		);

		expect(status).toBe(400);
	});

	it('refuses a body that does not say which way', async () => {
		const { status } = await call(
			pinCardHandler,
			`/api/cards/message/${postId}/pin`,
			{ kind: 'message', id: postId },
			{}
		);

		expect(status).toBe(400);
	});

	it('answers 401 without a session, and changes nothing', async () => {
		const { status } = await call(
			pinCardHandler,
			`/api/cards/message/${postId}/pin`,
			{ kind: 'message', id: postId },
			{ pinned: true },
			null
		);

		expect(status).toBe(401);
		expect(resolveCard(h, { kind: 'message', id: postId }).pinned).toBe(false);
	});
});

describe('POST /api/cards/[kind]/[id]/reactions', () => {
	it('puts an emoji on an update, which was a message`s alone', async () => {
		const { status, body } = await call(
			reactToCardHandler,
			`/api/cards/update/${updateId}/reactions`,
			{ kind: 'update', id: updateId },
			{ emoji: '🎉' }
		);

		expect(status).toBe(200);
		expect(body).toMatchObject({ on: true });
		expect(reactionsFor(h, 'update', [updateId]).map((one) => one.emoji)).toEqual(['🎉']);
	});

	it('toggles it off again, because that is what clicking one means', async () => {
		const path = `/api/cards/update/${updateId}/reactions`;
		const params = { kind: 'update', id: updateId };
		await call(reactToCardHandler, path, params, { emoji: '🎉' });

		const { body } = await call(reactToCardHandler, path, params, { emoji: '🎉' });

		expect(body).toMatchObject({ on: false });
		expect(reactionsFor(h, 'update', [updateId])).toEqual([]);
	});

	it('refuses a word that is not an emoji', async () => {
		const { status } = await call(
			reactToCardHandler,
			`/api/cards/update/${updateId}/reactions`,
			{ kind: 'update', id: updateId },
			{ emoji: 'nice one' }
		);

		expect(status).toBe(400);
	});
});

describe('POST /api/cards/[kind]/[id]/status', () => {
	it('marks one of the owner`s own posts as work', async () => {
		const { status, body } = await call(
			setCardStatusHandler,
			`/api/cards/message/${postId}/status`,
			{ kind: 'message', id: postId },
			{ status: 'todo' }
		);

		expect(status).toBe(200);
		expect(body).toMatchObject({ status: 'todo' });
		expect(resolveCard(h, { kind: 'message', id: postId }).status).toBe('todo');
	});

	it('moves an update along, and takes the mark off again', async () => {
		const path = `/api/cards/update/${updateId}/status`;
		const params = { kind: 'update', id: updateId };
		await call(setCardStatusHandler, path, params, { status: 'in_progress' });
		await call(setCardStatusHandler, path, params, { status: 'done' });

		expect(resolveCard(h, { kind: 'update', id: updateId }).status).toBe('done');

		await call(setCardStatusHandler, path, params, { status: null });
		expect(resolveCard(h, { kind: 'update', id: updateId }).status).toBe(null);
	});

	it('refuses a state that is not one of the five', async () => {
		const { status } = await call(
			setCardStatusHandler,
			`/api/cards/update/${updateId}/status`,
			{ kind: 'update', id: updateId },
			{ status: 'shipped' }
		);

		expect(status).toBe(400);
	});

	it('answers 401 without a session, and changes nothing', async () => {
		const { status } = await call(
			setCardStatusHandler,
			`/api/cards/message/${postId}/status`,
			{ kind: 'message', id: postId },
			{ status: 'todo' },
			null
		);

		expect(status).toBe(401);
		expect(resolveCard(h, { kind: 'message', id: postId }).status).toBe(null);
	});
});
