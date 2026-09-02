/**
 * `GET /s/[token]` — one shared card, readable without a session (design §7, §8).
 *
 * The token in the path is the whole authorisation, which is why this route is
 * in `TOKEN_AUTHED_PREFIXES` and why `$domain` hands back a purpose-built shape
 * rather than the dashboard's own card: a field added to `UpdateView` must not
 * be able to start publishing itself.
 *
 * Every failure is a 404 — unknown token, revoked link, deleted card — because a
 * visitor holding a dead link has no business learning which of those it was.
 */
import { error } from '@sveltejs/kit';
import { loadConfig } from '$config';
import { context, readShare } from '$domain';
import { sharePreview } from '$web/preview';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, setHeaders }) => {
	const config = loadConfig(process.env);
	const card = readShare(context(), { token: params.token, secret: config.TOKEN_SECRET });

	if (!card) error(404, 'not found');

	// A share link is for a person the owner sent it to, not for a crawler. This
	// is not access control — the link is the access control — but a shared card
	// turning up in a search index is not what "share" meant.
	setHeaders({ 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' });

	// Built here rather than in the component: an unfurl is fetched by a crawler
	// that runs no JavaScript, so these have to be in the server-rendered head.
	const preview = sharePreview(card, {
		baseUrl: config.PUBLIC_BASE_URL,
		token: params.token
	});

	return { card, token: params.token, preview };
};
