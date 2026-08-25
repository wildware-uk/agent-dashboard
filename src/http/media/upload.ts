/**
 * `PUT /api/upload/:token` (design §6, §8).
 *
 * The route an agent PUTs raw bytes to. It is exempt from the owner's session
 * guard by name in `src/http/auth/guard.ts` — an agent has a signed upload
 * token, not the owner's cookie — so the token *is* the authorisation, and every
 * check that matters happens in `$media` where the bytes are.
 *
 * This file is the translation layer, and the translation is the point. `$media`
 * refuses in its own vocabulary, and an agent needs those refusals to arrive as
 * distinguishable statuses:
 *
 * | media code           | status | what the agent should do                     |
 * | -------------------- | ------ | -------------------------------------------- |
 * | `token_rejected`     | 403    | call `create_upload` again                   |
 * | `too_large`          | 413    | call `create_upload` with the real size      |
 * | `unsupported_type`   | 415    | send bytes that really are the declared type |
 * | `invalid_argument`   | 400    | fix the request                              |
 * | `not_found`          | 404    | the reservation is gone; start over          |
 * | `conflict`           | 409    | those bytes already landed                   |
 *
 * A 400 for all six would leave an agent retrying blind, which is why
 * `$domain/media.ts` lets the `MediaError` through instead of flattening it.
 *
 * The per-token rate limit (design §8) is keyed on the token id from the URL and
 * applied *before* the signature is checked, so a client looping on one token —
 * or on rubbish — cannot spend this server's time on HMACs and SQLite. It is the
 * same sliding-window limiter `/mcp` uses.
 */
import { context, ingestUpload, type DomainContext } from '$domain';
import { isMediaError, type MediaErrorCode, type MediaSettings } from '$media';
import { createTokenRateLimiter, retryAfterSeconds, type TokenRateLimiter } from '$mcp';
import { mediaConfig } from './env';

/**
 * Attempts one upload token may make per window.
 *
 * A token is single use, so a client needs one — this leaves room for a couple of
 * network retries and stops a loop on a dead token from costing anything.
 */
export const UPLOAD_RATE_LIMIT = 6;

/** The window, in milliseconds. */
export const UPLOAD_RATE_WINDOW_MS = 60_000;

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type UploadRequestEvent = {
	request: Request;
	params: Partial<Record<'token', string>>;
};

export type UploadHandlerOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Media settings, injectable so tests need no environment. */
	settings?: () => MediaSettings | null;
	/** Defaults to the per-token limits above. */
	rateLimiter?: TokenRateLimiter;
};

export type UploadHandler = (event: UploadRequestEvent) => Promise<Response>;

/** Which status each media refusal becomes. See the table above. */
const STATUSES: Record<MediaErrorCode, number> = {
	token_rejected: 403,
	too_large: 413,
	unsupported_type: 415,
	invalid_argument: 400,
	not_found: 404,
	conflict: 409
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});
}

/**
 * The id half of a token, for rate limiting.
 *
 * Deliberately not the whole token: a client varying the signature on one id
 * must share that id's bucket, and the id is the part that identifies the grant.
 */
function bucketFor(token: string): string {
	return token.split('.')[0].slice(0, 64);
}

/** Build the `PUT` handler for the upload route. */
export function createUploadHandler(options: UploadHandlerOptions = {}): UploadHandler {
	const {
		context: getContext = context,
		settings: getSettings = mediaConfig,
		rateLimiter = createTokenRateLimiter({
			limit: UPLOAD_RATE_LIMIT,
			windowMs: UPLOAD_RATE_WINDOW_MS
		})
	} = options;

	return async (event) => {
		const settings = getSettings();
		if (!settings) {
			return json(503, {
				error: 'misconfigured',
				message: 'this deployment has no valid media configuration; see the server log'
			});
		}

		const token = event.params.token ?? '';
		const verdict = rateLimiter.take(bucketFor(token));
		if (!verdict.allowed) {
			return json(
				429,
				{ error: 'rate_limited', message: 'too many upload attempts for this token' },
				{ 'retry-after': String(retryAfterSeconds(verdict.retryAfterMs)) }
			);
		}

		const declared = Number(event.request.headers.get('content-length'));

		try {
			const stored = await ingestUpload(
				getContext(),
				{
					token,
					body: event.request.body,
					contentLength: Number.isFinite(declared) && declared > 0 ? declared : null
				},
				settings
			);

			return json(201, {
				media_id: stored.mediaId,
				kind: stored.kind,
				mime: stored.mime,
				bytes: stored.bytes,
				sha256: stored.sha256,
				status: stored.status,
				deduped: stored.deduped
			});
		} catch (error) {
			if (isMediaError(error)) {
				return json(STATUSES[error.code], { error: error.code, message: error.message });
			}
			// A bug here writes to somebody's disk, so it is logged rather than
			// echoed: whatever a thrown `TypeError` is holding is not for an agent.
			console.error('upload failed', error);
			return json(500, {
				error: 'internal_error',
				message: 'the dashboard failed to store this upload; see server logs'
			});
		}
	};
}
