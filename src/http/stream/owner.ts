/**
 * The owner check the live endpoints make for themselves (design §8).
 *
 * `src/hooks.server.ts` already refuses an unauthenticated `/api/...` request,
 * so this is the second of two locks — the same belt-and-braces as
 * `+layout.server.ts` does for pages. It matters more here than elsewhere: an
 * SSE connection is the whole feed of everything happening in the deployment,
 * held open for hours, and it must not become readable because a hook was ever
 * unwired or a route was mounted outside the guarded prefixes.
 *
 * The policy itself is not restated: this reads the same cookie with the same
 * secret through `$http/auth`.
 */
import { authConfig, sessionFromCookies, type AuthConfig, type SessionCookieReader } from '../auth';

/** The slice of SvelteKit's `RequestEvent` the live endpoints need. */
export type OwnerRequest = { cookies: SessionCookieReader };

/** Reads the same config the hook does; injectable so tests need no environment. */
export type OwnerCheck = (event: OwnerRequest) => boolean;

/**
 * Is this request carrying a valid owner session?
 *
 * Fails closed: an environment that does not validate yields no config, and
 * therefore no session, rather than an unguarded stream.
 */
export function ownerAuthenticated(
	event: OwnerRequest,
	config: () => AuthConfig | null = authConfig
): boolean {
	const secrets = config();
	if (!secrets) return false;
	return sessionFromCookies(event.cookies, secrets.sessionSecret) !== null;
}

/**
 * What an unauthenticated caller gets: the same JSON body the hook sends, so a
 * dashboard `fetch` branches on one shape whichever lock refused it.
 */
export function unauthenticatedResponse(): Response {
	return new Response(JSON.stringify({ error: 'unauthenticated' }), {
		status: 401,
		headers: { 'content-type': 'application/json' }
	});
}
