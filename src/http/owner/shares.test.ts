import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, findUpdateShare, postUpdate, readShare, type Update } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import type { OwnerHandler } from './actions';
import { revokeShareHandler, shareUpdateHandler } from './shares';

/**
 * `/api/updates/[id]/share` (design §7, §8).
 *
 * The endpoint that makes something readable without a session, so the two
 * things asserted hardest are that it needs the owner's cookie, and that the
 * response carries the URL exactly once and nothing else that could produce it
 * again.
 */
const SESSION_SECRET = 's'.repeat(32);
const TOKEN_SECRET = 't'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });
const settings = () => ({ secret: TOKEN_SECRET, baseUrl: 'https://agents.example.com' });

let h: Harness;
let update: Update;

beforeEach(() => {
	h = harness();
	const agentId = h.agent('claude');
	createProject(h, { name: 'Agent Dashboard' });
	update = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' });
});

async function call(
	factory: (options: object) => OwnerHandler,
	options: { method?: string; id?: string; cookie?: string | null } = {}
) {
	const handler = factory({ ctx: () => h, config, settings });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;

	const response = await handler({
		request: new Request('http://dash.test/api/updates/x/share', {
			method: options.method ?? 'POST'
		}),
		params: { id: options.id ?? update.id },
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

describe('only the owner may publish anything', () => {
	it.each([
		['share', shareUpdateHandler, 'POST'],
		['revoke', revokeShareHandler, 'DELETE']
	])('%s answers 401 without the session', async (_name, factory, method) => {
		const { response, body } = await call(factory, { method, cookie: null });

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
		expect(findUpdateShare(h, update.id)).toBeNull();
	});
});

describe('POST /api/updates/[id]/share', () => {
	it('answers with a working link, built on the deployment’s public origin', async () => {
		const { response, body } = await call(shareUpdateHandler);

		expect(response.status).toBe(200);
		expect(body.url).toMatch(/^https:\/\/agents\.example\.com\/s\/[A-Za-z0-9_-]{43}$/);

		const token = String(body.url).split('/s/')[1];
		expect(readShare(h, { token, secret: TOKEN_SECRET })).toMatchObject({
			update: { id: update.id }
		});
	});

	it('returns the token only inside the URL, and nothing that could rebuild it', async () => {
		const { body } = await call(shareUpdateHandler);
		const token = String(body.url).split('/s/')[1];

		expect(body.share).toMatchObject({ update_id: update.id });
		expect(JSON.stringify(body.share)).not.toContain(token);
		expect(JSON.stringify(body)).not.toContain('token_hash');
	});

	it('replaces the link when a card is shared twice', async () => {
		const first = String((await call(shareUpdateHandler)).body.url).split('/s/')[1];
		const second = String((await call(shareUpdateHandler)).body.url).split('/s/')[1];

		expect(second).not.toBe(first);
		expect(readShare(h, { token: first, secret: TOKEN_SECRET })).toBeNull();
		expect(readShare(h, { token: second, secret: TOKEN_SECRET })).not.toBeNull();
	});

	it('refuses a card that is not there', async () => {
		const { response, body } = await call(shareUpdateHandler, { id: 'nope' });

		expect(response.status).toBe(404);
		expect(body).toMatchObject({ error: 'not_found' });
	});
});

describe('DELETE /api/updates/[id]/share', () => {
	it('stops the link and says it did', async () => {
		const token = String((await call(shareUpdateHandler)).body.url).split('/s/')[1];

		const { response, body } = await call(revokeShareHandler, { method: 'DELETE' });

		expect(response.status).toBe(200);
		expect(body).toEqual({ revoked: true });
		expect(readShare(h, { token, secret: TOKEN_SECRET })).toBeNull();
	});

	it('is a truthful 200 when there was nothing to revoke', async () => {
		const { response, body } = await call(revokeShareHandler, { method: 'DELETE' });

		expect(response.status).toBe(200);
		expect(body).toEqual({ revoked: false });
	});
});
