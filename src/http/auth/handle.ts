/**
 * The route guard, as a SvelteKit `handle` hook (design §8).
 *
 * A hook rather than per-route code, because `+layout.server.ts` load functions
 * do not run for `+server.ts` endpoints: a layout guard alone would leave every
 * browser API route open. `src/http/routes/+layout.server.ts` guards the pages a
 * second time so that page protection does not depend on this file being wired
 * up, and `src/http/auth/guard.ts` is the single source of truth for which paths
 * either of them covers.
 */
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { bearerToken, type DeviceTokenCheck } from './bearer';
import { authConfig, type AuthConfig } from './env';
import { isApiPath, isBrowserApi, loginRedirect, requiresSession } from './guard';
import { sessionFromCookies } from './session';

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** What an unauthenticated request gets back. */
function refuse(event: RequestEvent): Response {
	if (isBrowserApi(event.url.pathname)) {
		// A `fetch` from the dashboard wants a status it can branch on, not the
		// HTML of a login page.
		return json(401, { error: 'unauthenticated' });
	}
	// 303: whatever the method was, the browser should GET the login page.
	return new Response(null, { status: 303, headers: { location: loginRedirect(event.url) } });
}

export function createAuthHandle({
	config = authConfig,
	device = () => false
}: {
	config?: () => AuthConfig | null;
	/** Injected because this module may not reach the database that knows the keys. */
	device?: DeviceTokenCheck;
} = {}): Handle {
	/** Is this the owner, by device key or by cookie? */
	const owner = (event: RequestEvent): boolean => {
		// A bearer decides on its own: a stale key must not ride on a cookie.
		const bearer = bearerToken(event.request.headers);
		if (bearer !== null) return device(bearer);
		const secrets = config();
		return Boolean(secrets && sessionFromCookies(event.cookies, secrets.sessionSecret));
	};

	return async ({ event, resolve }) => {
		const { pathname } = event.url;

		// `route.id` is null for anything that matched no route — static assets and
		// 404s. Those carry nothing to protect, and guarding them would turn a
		// missing file into a redirect loop.
		if (event.route.id === null) {
			// Except under `/api`: SvelteKit would render its HTML error page there,
			// through the root layout, which sends a visitor with no session to the
			// login page. An API caller wants a status. On the owner's paths a caller
			// who is not the owner gets the same 401 a real route gives, so a
			// stranger cannot tell which routes exist.
			if (!isApiPath(pathname)) return resolve(event);
			if (requiresSession(pathname) && !owner(event)) return refuse(event);
			return json(404, { error: 'not_found', message: `no such API route: ${pathname}` });
		}

		if (requiresSession(pathname) && !owner(event)) return refuse(event);

		return resolve(event);
	};
}

/** The hook `src/hooks.server.ts` installs. */
export const authHandle = createAuthHandle();
