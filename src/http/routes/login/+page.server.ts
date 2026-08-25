/**
 * The login route. A thin adapter over `$http/auth`: form data in, redirect or
 * failure out. Every decision — the argon2id check, the rate limit, the cookie
 * attributes, the redirect sanitising — lives in `src/http/auth/login.ts` where
 * it is unit tested.
 */
import { fail, redirect } from '@sveltejs/kit';
import { attemptLogin, authConfig, safeRedirectTarget, sessionFromCookies } from '$http/auth';
import type { Actions, PageServerLoad } from './$types';

/** `FormData` yields files as well as strings; only a string is a password. */
const asString = (value: FormDataEntryValue | null): string | null =>
	typeof value === 'string' ? value : null;

export const load: PageServerLoad = ({ cookies, url }) => {
	const secrets = authConfig();
	const redirectTo = safeRedirectTarget(url.searchParams.get('redirectTo'));

	// Already signed in: there is nothing to log into.
	if (secrets && sessionFromCookies(cookies, secrets.sessionSecret)) redirect(303, redirectTo);

	return { configured: secrets !== null, redirectTo };
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, url }) => {
		const form = await request.formData();

		const outcome = await attemptLogin({
			password: form.get('password'),
			redirectTo: asString(form.get('redirectTo')) ?? url.searchParams.get('redirectTo'),
			clientAddress: getClientAddress(),
			cookies
		});

		if (!outcome.ok) return fail(outcome.status, { error: outcome.error });

		redirect(303, outcome.redirectTo);
	}
};
