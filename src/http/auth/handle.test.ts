import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { createAuthHandle } from './handle';
import { SESSION_COOKIE, signSession } from './session';

const SESSION_SECRET = 's'.repeat(32);
const ADMIN_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: ADMIN_PASSWORD_HASH });

type EventOverrides = { path?: string; routeId?: string | null; cookie?: string };

function fakeEvent({ path = '/', routeId = '/x', cookie }: EventOverrides = {}) {
	const url = new URL(`http://dashboard.test${path}`);
	return {
		url,
		route: { id: routeId },
		request: new Request(url),
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

	it('fails closed when the deployment has no session secret configured', async () => {
		const resolve = resolver();

		const response = await createAuthHandle({ config: () => null })({
			event: fakeEvent({ cookie: signSession(SESSION_SECRET) }),
			resolve
		});

		expect(response.status).toBe(303);
		expect(resolve).not.toHaveBeenCalled();
	});
});
