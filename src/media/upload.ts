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
 * - The filename is validated, and then kept only for a `file` (migration 026):
 *   a download called `01M1P….bin` names nothing to the person clicking it, and
 *   an agent handed three files with no names cannot say which it is reading. It
 *   is still **never a path** — the extension comes from the type (`./paths.ts`)
 *   — and for an image or a video it is still thrown away, because the picture
 *   is its own label.
 */
import {
	findAgentById,
	insertMedia,
	insertUploadToken,
	type Db,
	type Media,
	type MediaKind
} from '$db';
import { mediaInvalid, mediaNotFound, tooLarge, unsupportedType } from './errors';
import { canonicalMime, kindForMime } from './mime';
import type { MediaSettings } from './settings';
import { UPLOAD_TOKEN_TTL_MS, signUploadToken, uploadUrl } from './tokens';

/** Long enough for any real screenshot name, short enough not to be a payload. */
export const FILENAME_MAX_LENGTH = 255;

export type CreateUploadInput = {
	db: Db;
	/** The agent, resolved from its bearer token by the adapter — never an argument. */
	agentId: string;
	/**
	 * What the caller calls the file.
	 *
	 * Stored for a `file` and shown beside its download; discarded for an image
	 * or a video (migration 026). Never a path either way.
	 */
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

/** @returns the name with its surrounding blanks gone, which is what is stored. */
function checkFilename(filename: string): string {
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

	return trimmed;
}

/**
 * The cap for one kind of upload.
 *
 * Three numbers rather than two because a `file` is never rendered: the reason
 * to keep it small is this deployment's disk, not a browser's patience
 * (`$config`'s `MAX_FILE_BYTES`).
 */
function limitFor(kind: MediaKind, settings: MediaSettings): number {
	if (kind === 'image') return settings.maxImageBytes;
	if (kind === 'video') return settings.maxVideoBytes;
	// Audio shares the file cap (migration 038) rather than getting a knob of its
	// own: an hour of speech is tens of megabytes, well inside it, and a fourth
	// limit would be a fourth thing to keep in step with `BODY_SIZE_LIMIT`.
	return settings.maxFileBytes;
}

/** "an image", "a video", "an audio", "a file" — the article follows the noun. */
function article(kind: MediaKind): string {
	return kind === 'image' || kind === 'audio' ? 'an' : 'a';
}

/**
 * What a caller is told when its declared type is not even a mime.
 *
 * Note what it does *not* say: there is no list of accepted types any more,
 * because a `file` may be anything well formed (migration 026). The one type
 * that is still refused outright is a string that is not a `type/subtype`.
 */
const MIME_HELP =
	'must look like "type/subtype", e.g. "image/png", "application/pdf" or ' +
	'"text/plain". Images and video are rendered on the card and are checked ' +
	'against their magic bytes; anything else is stored as a file the owner ' +
	'downloads.';

/**
 * Reserve a media id and mint the token that fills it.
 *
 * @throws {@link MediaError} `unsupported_type` for a declared type that is not
 *   a mime at all, `too_large` past the configured cap for its kind,
 *   `invalid_argument` for a size or filename that makes no sense, and
 *   `not_found` if the agent does not exist.
 */
export type OwnerMediaInput = {
	db: Db;
	filename: string;
	mime: string;
	/** `Content-Length`, or 0 when the browser did not say. Checked again as bytes arrive. */
	bytes?: number;
	now?: number;
};

/**
 * A media row for something the **owner** uploaded, with no token.
 *
 * An agent gets a single-use URL because it is somewhere else and MCP cannot
 * carry bytes: the token is what authorises a request that has no session. The
 * owner's browser already carries the session cookie on the request putting the
 * bytes, so a token would be a round trip that authorises what is already
 * authorised, plus a row in `upload_tokens` whose `agent_id` there is nobody to
 * fill in.
 *
 * So: the row, and then {@link storeBytes} on the same request. The validation
 * that matters — the type allowlist, the per-kind cap — is the same code, and
 * the cap is returned rather than assumed, because a browser's `Content-Length`
 * is a claim and the stream is where it is actually enforced.
 *
 * @throws {@link MediaError} `unsupported_type` for a declared type that is not
 *   a mime at all, `too_large` for a declared size past the cap for its kind.
 */
export function createOwnerMedia(
	settings: MediaSettings,
	input: OwnerMediaInput
): { media: Media; maxBytes: number; allowed: string[] } {
	const now = input.now ?? Date.now();

	const filename = checkFilename(input.filename);

	const mime = canonicalMime(input.mime);
	const kind = kindForMime(mime);
	if (!kind) throw unsupportedType(`${JSON.stringify(mime)} ${MIME_HELP}`);

	const limit = limitFor(kind, settings);
	if (input.bytes != null && input.bytes > limit) {
		throw tooLarge(
			`${article(kind)} ${kind} may be at most ${limit} bytes; this one declares ${input.bytes}`
		);
	}

	const media = insertMedia(input.db, {
		// No agent: this is the owner's own. `author` is what a card renders.
		agentId: null,
		author: 'human',
		kind,
		mime,
		bytes: 0,
		// No bytes yet. `./serve.ts` reads this as "nothing to serve".
		sha256: '',
		// Kept for a download, discarded for a picture (migration 026).
		filename: kind === 'file' ? filename : null,
		status: 'pending',
		createdAt: now
	});

	return { media, maxBytes: limit, allowed: [mime] };
}

export function createUpload(settings: MediaSettings, input: CreateUploadInput): CreatedUpload {
	const now = input.now ?? Date.now();

	const filename = checkFilename(input.filename);

	const mime = canonicalMime(input.mime);
	const kind = kindForMime(mime);
	if (!kind) throw unsupportedType(`${JSON.stringify(mime)} ${MIME_HELP}`);

	if (!Number.isInteger(input.bytes) || input.bytes < 1) {
		throw mediaInvalid('bytes must be the whole number of bytes the file has, and at least 1');
	}

	const limit = limitFor(kind, settings);
	if (input.bytes > limit) {
		throw tooLarge(
			`${article(kind)} ${kind} may be at most ${limit} bytes; this one declares ${input.bytes}`
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
			// Kept for a download, discarded for a picture (migration 026).
			filename: kind === 'file' ? filename : null,
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
