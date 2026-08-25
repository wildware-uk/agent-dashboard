/**
 * Signing out. A session is a signed cookie and nothing else, so this clears the
 * cookie and sends the owner back to the login page.
 *
 * It is a POST action rather than a link: a GET that logs you out is a link any
 * page on the internet can make your browser follow.
 */
import { redirect } from '@sveltejs/kit';
import { LOGIN_PATH, authConfig, logout, sessionFromCookies } from '$http/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies }) => {
	const secrets = authConfig();
	// Nothing to sign out of.
	if (!secrets || !sessionFromCookies(cookies, secrets.sessionSecret)) redirect(303, LOGIN_PATH);

	return {};
};

export const actions: Actions = {
	default: ({ cookies }) => {
		logout(cookies);
		redirect(303, LOGIN_PATH);
	}
};
