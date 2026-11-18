import { beforeEach, describe, expect, it } from 'vitest';
import {
	authenticateOwnerDevice,
	createProject,
	findMessage,
	listOwnerDevices,
	mintOwnerDevice,
	updateProject
} from '$domain';
import { findOwnerDeviceById } from '$db';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import type { OwnerHandler } from './actions';
import { setCardStatusHandler } from './cards';
import {
	createDeviceHandler,
	deleteDeviceHandler,
	listDevicesHandler,
	setAlertProjectsHandler,
	setApnsTokenHandler,
	setLiveActivityHandler,
	signInDeviceHandler,
	summaryHandler
} from './devices';
import { postMessageHandler } from './messages';

const SESSION_SECRET = 's'.repeat(32);
const TOKEN_SECRET = 't'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
beforeEach(() => {
	h = harness();
});

type CallOptions = {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
	/** A session cookie by default; `null` for none. */
	cookie?: string | null;
	bearer?: string;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({
		ctx: () => h,
		config,
		secret: () => TOKEN_SECRET,
		devices: (token: string) => authenticateOwnerDevice(h, { token, secret: TOKEN_SECRET })
	});
	const cookie =
		options.cookie === undefined
			? options.bearer
				? null
				: signSession(SESSION_SECRET)
			: options.cookie;
	const method = options.method ?? 'GET';
	const headers = new Headers();
	if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
	const init: RequestInit = { method, headers };
	if (options.body !== undefined && method !== 'GET') init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request('http://dash.test/api/devices', init),
		params: options.params ?? {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});
	return { response, body: await response.json() };
}

const mint = (name = 'phone') => mintOwnerDevice(h, { name, secret: TOKEN_SECRET });

describe('minting a device', () => {
	it('answers 201 with the key, shown only here', async () => {
		const { response, body } = await call(createDeviceHandler, {
			method: 'POST',
			body: { name: 'Alex’s iPhone' }
		});

		expect(response.status).toBe(201);
		expect(body).toEqual({
			device: { id: expect.any(String), name: 'Alex’s iPhone', createdAt: expect.any(String) },
			token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
		});
		expect(new Date(body.device.createdAt).toISOString()).toBe(body.device.createdAt);

		const listed = await call(listDevicesHandler);
		expect(JSON.stringify(listed.body)).not.toContain(body.token);
	});

	it.each([[{}], [{ name: '' }], [{ name: 'x'.repeat(101) }], [{ name: 7 }]])(
		'refuses %j',
		async (payload) => {
			const { response, body } = await call(createDeviceHandler, { method: 'POST', body: payload });

			expect(response.status).toBe(400);
			expect(body.error).toBe('invalid_argument');
		}
	);

	it('answers 401 without the owner', async () => {
		const { response } = await call(createDeviceHandler, {
			method: 'POST',
			body: { name: 'x' },
			cookie: null
		});

		expect(response.status).toBe(401);
	});
});

describe('a device key is owner auth', () => {
	it('opens an owner endpoint without a cookie', async () => {
		const { token } = mint();

		const { response, body } = await call(listDevicesHandler, { bearer: token });

		expect(response.status).toBe(200);
		expect(body.devices).toHaveLength(1);
	});

	it('is refused when it matches no device, even with a valid cookie', async () => {
		const { response, body } = await call(listDevicesHandler, {
			bearer: 'x'.repeat(43),
			cookie: signSession(SESSION_SECRET)
		});

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
	});

	it('stops working the moment the device is revoked', async () => {
		const { device, token } = mint();

		const removed = await call(deleteDeviceHandler, {
			method: 'DELETE',
			params: { id: device.id }
		});
		expect(removed.body).toEqual({ removed: true });

		const { response } = await call(listDevicesHandler, { bearer: token });
		expect(response.status).toBe(401);

		const again = await call(deleteDeviceHandler, { method: 'DELETE', params: { id: device.id } });
		expect(again.body).toEqual({ removed: false });
	});

	it('posts a ticket: a message, then marked as work', async () => {
		const { token } = mint();
		createProject(h, { name: 'Fees', slug: 'fees' });

		const posted = await call(postMessageHandler, {
			method: 'POST',
			bearer: token,
			body: { project: 'fees', body: 'fix the fee rounding' }
		});
		expect(posted.response.status).toBe(201);

		const marked = await call(setCardStatusHandler, {
			method: 'POST',
			bearer: token,
			params: { kind: 'message', id: posted.body.message.id },
			body: { status: 'todo' }
		});
		expect(marked.response.status).toBe(200);
		expect(findMessage(h, posted.body.message.id)?.status).toBe('todo');
	});

	it('still refuses a blank message carrying only media', async () => {
		const { token } = mint();
		createProject(h, { name: 'Fees', slug: 'fees' });

		const { response, body } = await call(postMessageHandler, {
			method: 'POST',
			bearer: token,
			body: { project: 'fees', body: '', mediaIds: ['01ABC'] }
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});
});

describe('listing devices', () => {
	it('says which push channels each has, and nothing secret', async () => {
		const { token } = mint('phone');
		mint('ipad');
		await call(setApnsTokenHandler, {
			method: 'PUT',
			bearer: token,
			body: { token: 'abcd', environment: 'production' }
		});

		const { body } = await call(listDevicesHandler);

		expect(body.devices).toEqual([
			{
				id: expect.any(String),
				name: 'phone',
				createdAt: expect.any(String),
				lastSeenAt: expect.any(String),
				hasApns: true,
				hasLiveActivity: false,
				alertProjects: null
			},
			expect.objectContaining({ name: 'ipad', lastSeenAt: null, hasApns: false })
		]);
		expect(Object.keys(body.devices[0])).not.toContain('tokenHash');
	});
});

describe('the calling device’s push tokens', () => {
	it('stores the alert token for the device that sent it', async () => {
		const { device, token } = mint();

		const { body } = await call(setApnsTokenHandler, {
			method: 'PUT',
			bearer: token,
			body: { token: 'ABCD', environment: 'sandbox' }
		});

		expect(body).toEqual({ ok: true });
		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			apnsToken: 'abcd',
			apnsEnvironment: 'sandbox'
		});
	});

	it('needs a device key, not a cookie', async () => {
		const { response, body } = await call(setApnsTokenHandler, {
			method: 'PUT',
			body: { token: 'abcd', environment: 'sandbox' }
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('refuses a bad environment', async () => {
		const { token } = mint();

		const { response } = await call(setApnsTokenHandler, {
			method: 'PUT',
			bearer: token,
			body: { token: 'abcd', environment: 'staging' }
		});

		expect(response.status).toBe(400);
	});

	it('stores Live Activity tokens, leaving an omitted one alone', async () => {
		const { device, token } = mint();

		await call(setLiveActivityHandler, {
			method: 'PUT',
			bearer: token,
			body: { updateToken: 'aa', pushToStartToken: 'bb' }
		});
		const { body } = await call(setLiveActivityHandler, {
			method: 'PUT',
			bearer: token,
			body: { updateToken: null }
		});

		expect(body).toEqual({ ok: true });
		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			liveActivityToken: null,
			pushToStartToken: 'bb'
		});
	});

	it('stores a start token alone, keeping the running activity token', async () => {
		const { device, token } = mint();
		await call(setLiveActivityHandler, {
			method: 'PUT',
			bearer: token,
			body: { updateToken: 'aa' }
		});

		const { response } = await call(setLiveActivityHandler, {
			method: 'PUT',
			bearer: token,
			body: { pushToStartToken: 'bb' }
		});

		expect(response.status).toBe(200);
		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			liveActivityToken: 'aa',
			pushToStartToken: 'bb'
		});
	});

	it('refuses a body that names neither token', async () => {
		const { token } = mint();

		const { response } = await call(setLiveActivityHandler, {
			method: 'PUT',
			bearer: token,
			body: {}
		});

		expect(response.status).toBe(400);
	});
});

describe('the calling device’s alert projects', () => {
	beforeEach(() => {
		createProject(h, { name: 'Fees', slug: 'fees' });
		createProject(h, { name: 'Docs', slug: 'docs' });
	});

	const put = (body: unknown, bearer?: string) =>
		call(setAlertProjectsHandler, { method: 'PUT', body, ...(bearer ? { bearer } : {}) });

	it('limits the device to the projects it names, and lists them by slug', async () => {
		const { device, token } = mint();
		mint('ipad');

		const { body } = await put({ projects: ['fees', 'Docs', 'fees'] }, token);

		expect(body).toEqual({ ok: true });
		expect(findOwnerDeviceById(h.db, device.id)?.alertProjectIds).toHaveLength(2);
		const listed = await call(listDevicesHandler);
		expect(listed.body.devices.map((d: { alertProjects: unknown }) => d.alertProjects)).toEqual([
			['fees', 'docs'],
			null
		]);
	});

	it('keeps a project on the list when its slug is renamed', async () => {
		const { token } = mint();
		await put({ projects: ['fees'] }, token);
		updateProject(h, 'fees', { slug: 'billing' });

		const listed = await call(listDevicesHandler);

		expect(listed.body.devices[0].alertProjects).toEqual(['billing']);
	});

	it('clears the limit with null', async () => {
		const { device, token } = mint();
		await put({ projects: ['fees'] }, token);

		const { body } = await put({ projects: null }, token);

		expect(body).toEqual({ ok: true });
		expect(findOwnerDeviceById(h.db, device.id)?.alertProjectIds).toBeNull();
	});

	it('accepts an empty list: alerts only about no project', async () => {
		const { device, token } = mint();

		await put({ projects: [] }, token);

		expect(findOwnerDeviceById(h.db, device.id)?.alertProjectIds).toEqual([]);
	});

	it('names the slugs it does not know, and changes nothing', async () => {
		const { device, token } = mint();

		const { response, body } = await put({ projects: ['fees', 'gone', 'lost'] }, token);

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
		expect(JSON.stringify(body)).toContain('gone, lost');
		expect(findOwnerDeviceById(h.db, device.id)?.alertProjectIds).toBeNull();
	});

	it.each([
		[{}],
		[{ projects: 'fees' }],
		[{ projects: ['fees', 7] }],
		[{ projects: Array.from({ length: 201 }, () => 'fees') }]
	])('refuses %j', async (payload) => {
		const { token } = mint();

		const { response, body } = await put(payload, token);

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('needs a device key, not a cookie', async () => {
		const { response, body } = await put({ projects: ['fees'] });

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('answers 401 without the owner', async () => {
		const { response } = await call(setAlertProjectsHandler, {
			method: 'PUT',
			body: { projects: null },
			cookie: null
		});

		expect(response.status).toBe(401);
	});
});

describe('the summary', () => {
	it('answers a device key with the summary', async () => {
		const { token } = mint();
		createProject(h, { name: 'Fees', slug: 'fees' });

		const { response, body } = await call(summaryHandler, { bearer: token });

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			onlineAgents: [],
			requests: [],
			work: { todo: 0, inProgress: 0, blocked: 0 },
			projects: [{ slug: 'fees', name: 'Fees' }],
			working: []
		});
		expect(typeof body.at).toBe('string');
	});

	it('answers 401 without the owner', async () => {
		const { response } = await call(summaryHandler, { cookie: null });

		expect(response.status).toBe(401);
	});
});

/**
 * `POST /api/devices/sign-in` — an app signs in with the owner password and gets
 * its own device key in one step, with no browser form and no cookie. The form
 * route refuses a different Origin, so an app pointed at a LAN address could
 * never sign in through it.
 */
describe('signing in an app', () => {
	const RIGHT = 'correct horse';

	function signIn(body: unknown, clientAddress = '10.0.0.5') {
		const handler = signInDeviceHandler({
			ctx: () => h,
			secret: () => TOKEN_SECRET,
			check: async ({ password, clientAddress: address }) => {
				attempts.push(address);
				return password === RIGHT
					? { ok: true }
					: { ok: false, status: 400, error: 'That password is not right.' };
			}
		});
		return handler({
			request: new Request('http://192.0.2.10:8010/api/devices/sign-in', {
				method: 'POST',
				body: JSON.stringify(body)
			}),
			clientAddress
		}).then(async (response) => ({ response, body: await response.json() }));
	}

	let attempts: string[] = [];
	beforeEach(() => {
		attempts = [];
	});

	it('mints a device key for the right password', async () => {
		const { response, body } = await signIn({ password: RIGHT, name: 'Alex’s Mac' });

		expect(response.status).toBe(201);
		expect(body).toEqual({
			device: { id: expect.any(String), name: 'Alex’s Mac', createdAt: expect.any(String) },
			token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
		});
		expect(authenticateOwnerDevice(h, { token: body.token, secret: TOKEN_SECRET })?.id).toBe(
			body.device.id
		);
		expect(attempts).toEqual(['10.0.0.5']);
	});

	it('mints nothing for the wrong password, and says why', async () => {
		const { response, body } = await signIn({ password: 'nope', name: 'Mac' });

		expect(response.status).toBe(400);
		expect(body).toEqual({ error: 'wrong_password', message: 'That password is not right.' });
		expect(listOwnerDevices(h)).toEqual([]);
	});

	it('passes on a rate limit with its wait', async () => {
		const handler = signInDeviceHandler({
			ctx: () => h,
			secret: () => TOKEN_SECRET,
			check: async () => ({ ok: false, status: 429, error: 'Too many attempts.', retryAfterS: 60 })
		});
		const response = await handler({
			request: new Request('http://dash.test/api/devices/sign-in', {
				method: 'POST',
				body: JSON.stringify({ password: RIGHT, name: 'Mac' })
			}),
			clientAddress: '10.0.0.5'
		});

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
	});

	it('checks the name before spending a password guess on it', async () => {
		const { response } = await signIn({ password: RIGHT, name: '' });

		expect(response.status).toBe(400);
		expect(attempts).toEqual([]);
	});
});
