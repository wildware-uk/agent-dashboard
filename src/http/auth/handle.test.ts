import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { createAuthHandle } from './handle';
import { SESSION_COOKIE, signSession } from './session';

const SESSION_SECRET = 's'.repeat(32);
const ADMIN_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: ADMIN_PASSWORD_HASH });

type EventOverrides = { path?: string; routeId?: string | null; cookie?: string; bearer?: string };

function fakeEvent({ path = '/', routeId = '/x', cookie, bearer }: EventOverrides = {}) {
	const url = new URL(`http://dashboard.test${path}`);
	const headers = bearer ? { authorization: `Bearer ${bearer}` } : undefined;
	return {
		url,
		route: { id: routeId },
		request: new Request(url, { headers }),
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	} as unknown as RequestEvent;
}

/** A stand-in for the rest of the SvelteKit pipeline. */
function resolver() {
	return vi.fn(async () => new Response('the real page', { status: 200 }));
}

describe('the route guard hook', () => {
	it('sends an unauthenticated browser request to the login page', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/projects/acme' }),
			resolve
		});

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?redirectTo=%2Fprojects%2Facme');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('answers an unauthenticated browser API call with 401 rather than HTML', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/api/stream' }),
			resolve
		});

		expect(response.status).toBe(401);
		expect(response.headers.get('content-type')).toContain('application/json');
		await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('lets a signed session through', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/', cookie: signSession(SESSION_SECRET) }),
			resolve
		});

		expect(await response.text()).toBe('the real page');
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('rejects a session signed with someone else’s secret', async () => {
		const response = await createAuthHandle({ config })({
			event: fakeEvent({ cookie: signSession('z'.repeat(32)) }),
			resolve: resolver()
		});

		expect(response.status).toBe(303);
	});

	it('never touches /mcp: it authenticates with a bearer token (design §5)', async () => {
		const resolve = resolver();
		const event = fakeEvent({ path: '/mcp', routeId: '/mcp' });
		const cookies = vi.spyOn(event.cookies, 'get');

		const response = await createAuthHandle({ config })({ event, resolve });

		expect(await response.text()).toBe('the real page');
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(cookies).not.toHaveBeenCalled();
	});

	it('leaves the login page reachable', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/login', routeId: '/login' }),
			resolve
		});

		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('ignores requests that match no route, so static assets and 404s are untouched', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/favicon.svg', routeId: null }),
			resolve
		});

		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('answers an unknown API path with a JSON 404 for the owner', async () => {
		const resolve = resolver();

		for (const auth of [
			{ cookie: signSession(SESSION_SECRET) },
			{ bearer: 'good' }
		] satisfies EventOverrides[]) {
			const response = await createAuthHandle({ config, device: (token) => token === 'good' })({
				event: fakeEvent({ path: '/api/does-not-exist', routeId: null, ...auth }),
				resolve
			});

			expect(response.status).toBe(404);
			expect(response.headers.get('content-type')).toContain('application/json');
			await expect(response.json()).resolves.toEqual({
				error: 'not_found',
				message: 'no such API route: /api/does-not-exist'
			});
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it('answers an unknown API path with a JSON 401 for anybody else, never a login redirect', async () => {
		const resolve = resolver();

		for (const auth of [{}, { bearer: 'stale' }] satisfies EventOverrides[]) {
			const response = await createAuthHandle({ config, device: () => false })({
				event: fakeEvent({ path: '/api/does-not-exist/', routeId: null, ...auth }),
				resolve
			});

			expect(response.status).toBe(401);
			expect(response.headers.get('location')).toBeNull();
			await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' });
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it('answers an unknown path on an agent surface with a JSON 404, whoever asks', async () => {
		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/api/agent/nope', routeId: null }),
			resolve: resolver()
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
	});

	it('fails closed when the deployment has no session secret configured', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config: () => null })({
			event: fakeEvent({ cookie: signSession(SESSION_SECRET) }),
			resolve
		});

		expect(response.status).toBe(303);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('lets one of the owner’s phones through on its device key', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config, device: (token) => token === 'good' })({
			event: fakeEvent({ path: '/api/summary', bearer: 'good' }),
			resolve
		});

		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('refuses a device key that names no device, even beside a valid cookie', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config, device: () => false })({
			event: fakeEvent({
				path: '/api/summary',
				bearer: 'stale',
				cookie: signSession(SESSION_SECRET)
			}),
			resolve
		});

		expect(response.status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('accepts no device key unless it is given a way to check one', async () => {
		const response = await createAuthHandle({ config })({
			event: fakeEvent({ path: '/api/summary', bearer: 'anything' }),
			resolve: resolver()
		});

		expect(response.status).toBe(401);
	});
});
