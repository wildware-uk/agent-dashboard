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
import { authConfig, type AuthConfig } from './env';
import { isBrowserApi, loginRedirect, requiresSession } from './guard';
import { sessionFromCookies } from './session';

/** What an unauthenticated request gets back. */
function refuse(event: RequestEvent): Response {
	if (isBrowserApi(event.url.pathname)) {
		// A `fetch` from the dashboard wants a status it can branch on, not the
		// HTML of a login page.
		return new Response(JSON.stringify({ error: 'unauthenticated' }), {
			status: 401,
			headers: { 'content-type': 'application/json' }
		});
	}
	// 303: whatever the method was, the browser should GET the login page.
	return new Response(null, { status: 303, headers: { location: loginRedirect(event.url) } });
}

export function createAuthHandle({
	config = authConfig
}: { config?: () => AuthConfig | null } = {}): Handle {
	return async ({ event, resolve }) => {
		// `route.id` is null for anything that matched no route — static assets and
		// 404s. Those carry nothing to protect, and guarding them would turn a
		// missing file into a redirect loop.
		if (event.route.id !== null && requiresSession(event.url.pathname)) {
			const secrets = config();
			const session = secrets && sessionFromCookies(event.cookies, secrets.sessionSecret);
			if (!session) return refuse(event);
		}

		return resolve(event);
	};
}

/** The hook `src/hooks.server.ts` installs. */
export const authHandle = createAuthHandle();
