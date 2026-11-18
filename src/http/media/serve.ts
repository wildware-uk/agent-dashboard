/**
 * `GET /media/:id/:variant` (design §6, §8).
 *
 * The response headers are the security here, so they are stated once and
 * asserted in `./serve.test.ts`:
 *
 * - **`X-Content-Type-Options: nosniff`** — the emitted `Content-Type` comes from
 *   bytes that were sniffed at ingest, and this stops a browser second-guessing
 *   it and executing something.
 * - **`Content-Disposition`** — `inline` for the media the dashboard renders,
 *   because a download prompt for an agent's screenshot is not the product; and
 *   `attachment` for a `file` (migration 026), which together with the
 *   `application/octet-stream` `$media` emits for one is what keeps "any file
 *   may be uploaded" from meaning "any HTML runs on the dashboard's origin".
 *   The saved name is the uploader's text, so it is **encoded into the header**
 *   — quoted with the awkward characters removed, plus an RFC 5987 `filename*`
 *   for anything not ASCII — never concatenated into it.
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
import { resolveRange } from './range';
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
	/**
	 * Who may read these bytes. Defaults to the owner's session.
	 *
	 * The seam exists for share links (design §7): a public visitor holds a token
	 * that grants one card, and the check is "does this token cover this media
	 * id" rather than "is this the owner". Everything below it — the sniffed
	 * content type, the immutable cache, the range handling, the hardening
	 * headers — is identical, and duplicating it for the public route is exactly
	 * how the two would drift apart.
	 */
	authorise?: (event: MediaRequestEvent) => boolean | Promise<boolean>;
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
	const {
		context: getContext = context,
		settings: getSettings = mediaConfig,
		config,
		authorise
	} = options;

	return async (event) => {
		if (authorise) {
			// A share link either covers this media or it does not, and a visitor
			// must not be able to tell a wrong token from a right token aimed at
			// somebody else's card: both are 404, never 401.
			if (!(await authorise(event))) return notFound();
		} else if (!ownerAuthenticated(event, config)) {
			return unauthenticatedResponse();
		}

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
			'content-disposition': disposition(file.disposition, file.filename),
			'content-security-policy': "default-src 'none'; sandbox",
			// Seeking a video is a byte range. Answering `none` here is what made the
			// scrub bar snap back to zero: the player asks for a window near the
			// middle of the file, gets the whole thing with a 200, and gives up.
			'accept-ranges': 'bytes',
			etag: file.etag
		});

		if (matches(event.request.headers.get('if-none-match'), file.etag)) {
			// 304 carries no body, and must not carry a length for one either.
			headers.delete('content-length');
			return new Response(null, { status: 304, headers });
		}

		const verdict = resolveRange(event.request.headers.get('range'), file.bytes);

		if (verdict.kind === 'unsatisfiable') {
			// RFC 9110: 416 states the real length so the client can ask again.
			headers.set('content-range', `bytes */${file.bytes}`);
			headers.delete('content-length');
			return new Response(null, { status: 416, headers });
		}

		if (verdict.kind === 'partial') {
			const { start, end } = verdict.range;
			headers.set('content-range', `bytes ${start}-${end}/${file.bytes}`);
			headers.set('content-length', String(end - start + 1));
			return new Response(file.open(verdict.range), { status: 206, headers });
		}

		return new Response(file.open(), { status: 200, headers });
	};
}

/**
 * The `Content-Disposition` header for one file.
 *
 * Two forms, as RFC 6266 recommends: a quoted `filename` every client
 * understands, reduced to the ASCII a header may carry, and a `filename*` in
 * RFC 5987 form carrying the real name for those that do. Neither is
 * concatenation — the quoted form has its quotes, backslashes and control
 * characters removed, and the encoded form is percent-encoded — because the name
 * is text somebody else chose and a header is a place a newline in it would do
 * real damage.
 */
export function disposition(kind: 'inline' | 'attachment', filename: string | null): string {
	if (kind === 'inline') return 'inline';
	if (!filename) return 'attachment';

	const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(filename);

	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
