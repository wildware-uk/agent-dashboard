/**
 * How the media pipeline reports a refusal.
 *
 * `$media` cannot throw a `DomainError`: the arrow points the other way —
 * `$domain` imports `$media` (design §2) — and it cannot throw an HTTP status
 * either, because it does not know which front door the bytes came through.
 * So it throws one of these, and each caller maps it: `$domain/media.ts` onto
 * its own three codes for MCP tools, and `$http/media/` onto a status.
 *
 * The upload-specific codes exist because 400 is the wrong answer to both of the
 * interesting failures. An agent that sent a 300MB video needs to know the size
 * was the problem (413) and an agent that sent a zip needs to know the *type*
 * was (415); "invalid argument" for both would leave it retrying blind.
 */

/** Why a media call failed. */
export type MediaErrorCode =
	/** The arguments cannot be honoured — an unknown mime, a nonsense size. */
	| 'invalid_argument'
	/** No such media, or no such variant of it. */
	| 'not_found'
	/** The state refuses it: bytes already landed for this media. */
	| 'conflict'
	/**
	 * The upload token is missing, forged, expired, or already spent. One code
	 * for all four on purpose: a caller that can tell "expired" from "never
	 * existed" has an oracle for guessing tokens.
	 */
	| 'token_rejected'
	/** The body went past the cap this token authorised. */
	| 'too_large'
	/** The bytes are not one of the seven allowed types, or are not what was declared. */
	| 'unsupported_type';

/** An expected, reportable media failure. Anything else escaping is a bug. */
export class MediaError extends Error {
	readonly code: MediaErrorCode;

	constructor(code: MediaErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'MediaError';
		this.code = code;
	}
}

/** Whether a caught value is one of ours. */
export function isMediaError(value: unknown): value is MediaError {
	return value instanceof MediaError;
}

const make = (code: MediaErrorCode) => (message: string, options?: { cause?: unknown }) =>
	new MediaError(code, message, options);

export const mediaInvalid = make('invalid_argument');
export const mediaNotFound = make('not_found');
export const mediaConflict = make('conflict');
export const tokenRejected = make('token_rejected');
export const tooLarge = make('too_large');
export const unsupportedType = make('unsupported_type');
