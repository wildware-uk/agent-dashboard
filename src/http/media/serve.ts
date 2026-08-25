/**
 * `GET /media/:id/:variant` (design §6, §8).
 *
 * The response headers are the security here, so they are stated once and
 * asserted in `./serve.test.ts`:
 *
 * - **`X-Content-Type-Options: nosniff`** — the emitted `Content-Type` comes from
 *   bytes that were sniffed at ingest, and this stops a browser second-guessing
 *   it and executing something.
 * - **`Content-Disposition: inline`** — the dashboard renders media in place; a
 *   download prompt for an agent's screenshot is not the product.
 * - **`Cache-Control: public, max-age=31536000, immutable`** — an address
 *   `/media/:id/:variant` always answers with the same bytes, so it can be
 *   cached forever. `ETag` is derived from the sha256, and a matching
 *   `If-None-Match` is answered 304.
 * - **`Content-Security-Policy: default-src 'none'; sandbox`** — belt and braces
 *   for the case where the owner navigates straight to a media URL: whatever
 *   arrives is inert.
 * - **`Accept-Ranges: none`** — honest. Range requests are not implemented here,
 *   and claiming otherwise breaks a seeking video player rather than pleasing it.
 *
 * Everything a request could steer is a closed set: `$media` requires the id to
 * be a ULID with a row, and the variant to be one it names. There is no
 * user-supplied string anywhere near a path, and the temp directory uploads
 * stream through is outside the served tree entirely.
 *
 * The owner's session is required. The hook in `src/hooks.server.ts` already
 * refuses an unauthenticated `/media/...` request; this checks again for itself,
 * because these bytes are whatever an agent saw on somebody's screen.
 */
import { context, readMediaVariant, type DomainContext } from '$domain';
import { isVariant, type MediaSettings } from '$media';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse } from '../stream';
import { mediaConfig } from './env';

/** A year. The bytes at one address never change, so this is safe to promise. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type MediaRequestEvent = {
	request: Request;
	params: Partial<Record<'id' | 'variant', string>>;
	cookies: SessionCookieReader;
};

export type MediaHandlerOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Media settings, injectable so tests need no environment. */
	settings?: () => MediaSettings | null;
	/** Session secrets, injectable so tests need no environment. */
	config?: () => AuthConfig | null;
};

export type MediaHandler = (event: MediaRequestEvent) => Promise<Response>;

function notFound(): Response {
	return new Response(JSON.stringify({ error: 'not_found' }), {
		status: 404,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

/** Build the `GET` handler for the media route. */
export function createMediaHandler(options: MediaHandlerOptions = {}): MediaHandler {
	const { context: getContext = context, settings: getSettings = mediaConfig, config } = options;

	return async (event) => {
		if (!ownerAuthenticated(event, config)) return unauthenticatedResponse();

		const settings = getSettings();
		if (!settings) {
			return new Response(JSON.stringify({ error: 'misconfigured' }), {
				status: 503,
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
			});
		}

		const id = event.params.id ?? '';
		const variant = event.params.variant ?? '';
		// Checked here as well as in `$media` so a variant that is not one of ours
		// never becomes a lookup at all.
		if (!isVariant(variant)) return notFound();

		const file = await readMediaVariant(getContext(), { id, variant }, settings).catch(
			() => undefined
		);
		if (!file) return notFound();

		const headers = new Headers({
			'content-type': file.mime,
			'content-length': String(file.bytes),
			'cache-control': IMMUTABLE_CACHE_CONTROL,
			'x-content-type-options': 'nosniff',
			'content-disposition': 'inline',
			'content-security-policy': "default-src 'none'; sandbox",
			'accept-ranges': 'none',
			etag: file.etag
		});

		if (matches(event.request.headers.get('if-none-match'), file.etag)) {
			// 304 carries no body, and must not carry a length for one either.
			headers.delete('content-length');
			return new Response(null, { status: 304, headers });
		}

		return new Response(file.open(), { status: 200, headers });
	};
}

/**
 * Whether the client already has this exact representation.
 *
 * A list, because a browser may send several validators, and `*` because that is
 * what a client sends to mean "if you have it at all".
 */
function matches(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	if (ifNoneMatch.trim() === '*') return true;
	return ifNoneMatch
		.split(',')
		.map((candidate) => candidate.trim().replace(/^W\//, ''))
		.includes(etag);
}
