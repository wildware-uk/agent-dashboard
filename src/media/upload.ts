/**
 * `create_upload`: reserving a place for bytes that have not arrived yet
 * (design §6 steps 1-2).
 *
 * The two-step protocol exists because agents have no local install (§2): they
 * cannot hand this server a path, so they ask for somewhere to PUT to. That
 * makes the reservation the moment every rule about *what* may be stored gets
 * applied — the allowlist and the size cap are checked here, while it is still
 * only a claim, and re-checked in `./ingest.ts` against the actual bytes.
 *
 * What is written down, and what is not:
 *
 * - The media row is `pending` with an **empty `sha256`**, which is this
 *   module's way of saying "no bytes yet". `./serve.ts` refuses to serve such a
 *   row, and the sweeper collects it if the agent never follows through.
 * - The token row carries the cap and a one-entry mime allowlist, so ingest
 *   enforces the grant it was actually given rather than re-deriving it.
 * - The filename is validated and then **thrown away**. It is not a column
 *   (design §3) and it is not a path: the extension comes from the sniffed type
 *   (`./paths.ts`). Validating it anyway means an agent that sends rubbish hears
 *   about it instead of wondering why its label vanished.
 */
import { findAgentById, insertMedia, insertUploadToken, type Db } from '$db';
import { mediaInvalid, mediaNotFound, tooLarge, unsupportedType } from './errors';
import { isAllowedMime, kindForMime, normaliseMime } from './mime';
import type { MediaSettings } from './settings';
import { UPLOAD_TOKEN_TTL_MS, signUploadToken, uploadUrl } from './tokens';

/** Long enough for any real screenshot name, short enough not to be a payload. */
export const FILENAME_MAX_LENGTH = 255;

export type CreateUploadInput = {
	db: Db;
	/** The agent, resolved from its bearer token by the adapter — never an argument. */
	agentId: string;
	/** What the agent calls the file. A label only: it is stored nowhere. */
	filename: string;
	/** The type the agent claims. Checked against the bytes at ingest. */
	mime: string;
	/** Exact byte length of the file. Becomes the cap the upload is cut off at. */
	bytes: number;
	now?: number;
};

/** What an agent needs to perform the upload, and nothing more. */
export type CreatedUpload = {
	mediaId: string;
	/** Absolute, from `PUBLIC_BASE_URL`. */
	uploadUrl: string;
	/** Milliseconds since the epoch; the adapter formats it. */
	expiresAt: number;
	/**
	 * The cap the PUT is enforced against: the declared size, or the configured
	 * limit for this kind if that is smaller.
	 */
	maxBytes: number;
	/** The signed token itself, for a caller that wants the path rather than the URL. */
	token: string;
};

function checkFilename(filename: string): void {
	const trimmed = filename.trim();
	if (trimmed === '') throw mediaInvalid('filename is required');
	if (trimmed.length > FILENAME_MAX_LENGTH) {
		throw mediaInvalid(`filename must be at most ${FILENAME_MAX_LENGTH} characters`);
	}
	// Control characters in a filename are either a mistake or an attempt to
	// smuggle something through a log line or a header.
	for (const character of trimmed) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) throw mediaInvalid('filename contains control characters');
	}
}

/**
 * Reserve a media id and mint the token that fills it.
 *
 * @throws {@link MediaError} `unsupported_type` for anything off the allowlist
 *   (SVG included, always), `too_large` past the configured cap,
 *   `invalid_argument` for a size or filename that makes no sense, and
 *   `not_found` if the agent does not exist.
 */
export function createUpload(settings: MediaSettings, input: CreateUploadInput): CreatedUpload {
	const now = input.now ?? Date.now();

	checkFilename(input.filename);

	const mime = normaliseMime(input.mime);
	const kind = kindForMime(mime);
	if (!isAllowedMime(mime) || !kind) {
		throw unsupportedType(
			`${JSON.stringify(mime)} is not an accepted type. Allowed: image/png, image/jpeg, ` +
				`image/webp, image/gif, video/mp4, video/webm, video/quicktime. SVG is never accepted.`
		);
	}

	if (!Number.isInteger(input.bytes) || input.bytes < 1) {
		throw mediaInvalid('bytes must be the whole number of bytes the file has, and at least 1');
	}

	const limit = kind === 'image' ? settings.maxImageBytes : settings.maxVideoBytes;
	if (input.bytes > limit) {
		// "an image" / "a video": the article has to follow the noun.
		const article = kind === 'image' ? 'an' : 'a';
		throw tooLarge(
			`${article} ${kind} may be at most ${limit} bytes; this one declares ${input.bytes}`
		);
	}

	if (!findAgentById(input.db, input.agentId)) {
		throw mediaNotFound(`no such agent: ${input.agentId}`);
	}

	// The declared size is the cap: an agent that knows its file knows this
	// number, and a tighter cap means a lying body is cut off sooner.
	const maxBytes = Math.min(input.bytes, limit);
	const expiresAt = now + UPLOAD_TOKEN_TTL_MS;

	// One transaction: a media row with no token is an orphan the agent can never
	// fill, and a token with no media row cannot exist at all (foreign key).
	const created = input.db.transaction(() => {
		const media = insertMedia(input.db, {
			agentId: input.agentId,
			kind,
			mime,
			bytes: input.bytes,
			// No bytes yet. `./serve.ts` reads this as "nothing to serve".
			sha256: '',
			status: 'pending',
			createdAt: now
		});

		const token = insertUploadToken(input.db, {
			agentId: input.agentId,
			mediaId: media.id,
			maxBytes,
			mimeAllow: [mime],
			expiresAt
		});

		return { mediaId: media.id, tokenId: token.id };
	})();

	const token = signUploadToken(settings.tokenSecret, created.tokenId);

	return {
		mediaId: created.mediaId,
		uploadUrl: uploadUrl(settings, token),
		expiresAt,
		maxBytes,
		token
	};
}
