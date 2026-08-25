/**
 * The page half of the session guard (design §8).
 *
 * `src/hooks.server.ts` already guards every route, endpoints included. This
 * repeats the check for pages, because a layout load is the one place a page
 * cannot be rendered without, so browser routes stay protected even if the hook
 * is ever unwired. Both read the same policy from `$http/auth`, so there is one
 * list of guarded paths, not two.
 *
 * It also tells every page whether the owner is signed in, which is what a
 * "Sign out" control in the shell needs.
 */
import { redirect } from '@sveltejs/kit';
import { authConfig, loginRedirect, requiresSession, sessionFromCookies } from '$http/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ cookies, url }) => {
	const secrets = authConfig();
	const session = secrets ? sessionFromCookies(cookies, secrets.sessionSecret) : null;

	if (!session && requiresSession(url.pathname)) redirect(303, loginRedirect(url));

	return { authenticated: session !== null };
};
