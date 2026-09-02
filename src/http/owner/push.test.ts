import { beforeEach, describe, expect, it } from 'vitest';
import { listPushSubscriptionsFor, subscribeToPush } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import type { OwnerHandler } from './actions';
import { pushStatusHandler, subscribePushHandler, unsubscribePushHandler } from './push';

/**
 * `/api/push` (design §7).
 *
 * The settings are injected rather than read from the environment, because the
 * two states that matter — a deployment with a keypair and one without — are
 * exactly what these endpoints branch on, and neither should need a `.env` to
 * assert.
 */
const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });
const KEYS = {
	publicKey: 'the-public-key',
	privateKey: 'private',
	subject: 'mailto:o@example.com'
};

let h: Harness;
beforeEach(() => {
	h = harness();
});

type CallOptions = {
	method?: string;
	body?: unknown;
	url?: string;
	settings?: () => typeof KEYS | null;
	cookie?: string | null;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({
		ctx: () => h,
		config,
		settings: options.settings ?? (() => KEYS)
	});
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const method = options.method ?? 'GET';
	const init: RequestInit = { method };
	// A GET may not carry one, and the 401 cases pass a body to every handler so
	// that one table can cover all three verbs.
	if (options.body !== undefined && method !== 'GET') init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request(options.url ?? 'http://dash.test/api/push', init),
		params: {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

const subscription = {
	endpoint: 'https://push.example/one',
	keys: { p256dh: 'p', auth: 'a' },
	label: 'a phone'
};

describe('nobody without the owner session gets near any of it', () => {
	it.each([
		['status', pushStatusHandler, 'GET'],
		['subscribe', subscribePushHandler, 'POST'],
		['unsubscribe', unsubscribePushHandler, 'DELETE']
	])('%s answers 401', async (_name, factory, method) => {
		const { response, body } = await call(factory, { method, cookie: null, body: subscription });

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
	});
});

describe('GET /api/push', () => {
	it('hands over the public key, which is not a secret', async () => {
		const { response, body } = await call(pushStatusHandler);

		expect(response.status).toBe(200);
		expect(body).toEqual({
			enabled: true,
			publicKey: 'the-public-key',
			subscriptions: 0,
			devices: []
		});
	});

	it('never hands over the private half', async () => {
		const { body } = await call(pushStatusHandler);

		expect(JSON.stringify(body)).not.toContain('private');
	});

	it('says push is off when the deployment has no keypair', async () => {
		const { body } = await call(pushStatusHandler, { settings: () => null });

		expect(body).toMatchObject({ enabled: false, publicKey: null });
	});

	it('counts the browsers already subscribed', async () => {
		subscribeToPush(h, subscription);

		expect((await call(pushStatusHandler)).body).toMatchObject({ subscriptions: 1 });
	});

	it('lists each device so a browser can find its own settings', async () => {
		subscribeToPush(h, subscription);

		const { body } = await call(pushStatusHandler);

		expect(body.devices).toEqual([
			{
				endpoint: 'https://push.example/one',
				label: 'a phone',
				last_sent_at: null,
				// Stated rather than left absent: a client that had to know the
				// default would be a second place it is written down.
				// `comment` joined the defaults: a reply to you and a note on a
				// thread are two events, and both are on until the owner says otherwise.
				prefs: { types: ['request', 'update', 'message', 'comment'] }
			}
		]);
	});

	it('never lists the browser keys, which are not the owner’s business either', async () => {
		subscribeToPush(h, subscription);

		const { body } = await call(pushStatusHandler);

		expect(JSON.stringify(body)).not.toContain('p256dh');
	});
});

describe('POST /api/push', () => {
	it('stores the subscription and echoes only the endpoint back', async () => {
		const { response, body } = await call(subscribePushHandler, {
			method: 'POST',
			body: subscription
		});

		expect(response.status).toBe(200);
		expect(body).toEqual({ subscribed: true, endpoint: 'https://push.example/one' });
		expect(listPushSubscriptionsFor(h)).toHaveLength(1);
	});

	it('never echoes the browser keys back', async () => {
		const { body } = await call(subscribePushHandler, { method: 'POST', body: subscription });

		expect(JSON.stringify(body)).not.toContain('p256dh');
	});

	it('is idempotent, so a browser subscribing on every load stays one row', async () => {
		await call(subscribePushHandler, { method: 'POST', body: subscription });
		await call(subscribePushHandler, { method: 'POST', body: subscription });

		expect(listPushSubscriptionsFor(h)).toHaveLength(1);
	});

	it('refuses when the deployment cannot push, rather than storing a dead row', async () => {
		const { response, body } = await call(subscribePushHandler, {
			method: 'POST',
			body: subscription,
			settings: () => null
		});

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ error: 'conflict' });
		expect(listPushSubscriptionsFor(h)).toHaveLength(0);
	});

	it('refuses a subscription the domain will not have', async () => {
		const { response, body } = await call(subscribePushHandler, {
			method: 'POST',
			body: { endpoint: 'http://push.example/x', keys: { p256dh: 'p', auth: 'a' } }
		});

		expect(response.status).toBe(400);
		expect(body).toMatchObject({ error: 'invalid_argument' });
	});
});

describe('DELETE /api/push', () => {
	it('forgets the browser named in the query', async () => {
		subscribeToPush(h, subscription);

		const { response, body } = await call(unsubscribePushHandler, {
			method: 'DELETE',
			url: `http://dash.test/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`
		});

		expect(response.status).toBe(200);
		expect(body).toEqual({ removed: true });
		expect(listPushSubscriptionsFor(h)).toHaveLength(0);
	});

	it('says so plainly when there was nothing to forget', async () => {
		const { response, body } = await call(unsubscribePushHandler, {
			method: 'DELETE',
			url: 'http://dash.test/api/push?endpoint=https%3A%2F%2Fpush.example%2Fgone'
		});

		expect(response.status).toBe(200);
		expect(body).toEqual({ removed: false });
	});

	it('refuses a call that names no endpoint at all', async () => {
		const { response } = await call(unsubscribePushHandler, { method: 'DELETE' });

		expect(response.status).toBe(400);
	});
});
