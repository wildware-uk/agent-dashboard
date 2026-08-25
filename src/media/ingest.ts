/**
 * `PUT /api/upload/:token`: getting bytes onto disk safely (design §6 step 3).
 *
 * This is the highest-risk surface in the product — it is the one place a
 * process on somebody else's machine writes a file on this one — so the order
 * of operations is the design, not an implementation detail:
 *
 * 1. **Verify the token before touching the body.** A forged, expired or spent
 *    token costs one HMAC and one conditional UPDATE, and the request body is
 *    never read at all. Spending is a single atomic statement in `$db`, so of
 *    two concurrent PUTs with one token exactly one proceeds.
 * 2. **Refuse an oversized `Content-Length` outright**, purely to save the
 *    transfer — and then *never trust it again*.
 * 3. **Count while writing.** The cap is checked per chunk, and the moment it is
 *    passed the stream is cancelled and the partial file unlinked. A body that
 *    lies about its length is cut off mid-flight rather than buffered, measured
 *    and then rejected, which is the difference between a 1KB cap costing 1KB of
 *    memory and costing whatever the sender felt like sending.
 * 4. **Sniff the first {@link SNIFF_BYTES} before opening a file at all.** The
 *    head is held in memory, checked against the type the token authorised, and
 *    only written once it agrees. A zip renamed `.png` and an SVG therefore
 *    never reach the disk in any form.
 * 5. **Hash everything for dedup.** Identical bytes are stored once: the second
 *    upload hard-links the first file, so each media row is still independently
 *    addressable and independently deletable while the bytes exist once.
 *
 * What this does *not* do is flip the row to `ready` or publish `media.ready`.
 * That belongs to the derivative pipeline (design §6 steps 4-5); an upload
 * leaves a `pending` row with its real size and hash written down.
 */
import {
	consumeUploadToken,
	findMediaById,
	findMediaBySha256,
	setMediaBytes,
	type Db,
	type Media
} from '$db';
import { createHash } from 'node:crypto';
import { link, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	mediaConflict,
	mediaInvalid,
	mediaNotFound,
	tokenRejected,
	tooLarge,
	unsupportedType
} from './errors';
import { SNIFF_BYTES, isAllowedMime, sniffMime } from './mime';
import { originalFile, tempUploadFile, tempUploadRoot } from './paths';
import type { MediaSettings } from './settings';
import { parseUploadToken } from './tokens';

export type IngestInput = {
	db: Db;
	/** The signed token from the URL. */
	token: string;
	/** The request body. `null` is what a PUT with no body arrives as. */
	body: ReadableStream<Uint8Array> | null;
	/** `Content-Length`, if the client sent one. A hint, never an authority. */
	contentLength?: number | null;
	now?: number;
};

export type IngestResult = {
	/** The media row as it now stands: real size, real hash, still `pending`. */
	media: Media;
	/** Whether these bytes were already on disk under another media id. */
	deduped: boolean;
};

/**
 * Take one upload.
 *
 * @throws {@link MediaError} — `token_rejected` (forged, unknown, expired or
 *   spent), `too_large`, `unsupported_type` (bytes disagree with the
 *   reservation, or are not on the allowlist), `invalid_argument` (empty body),
 *   `conflict` (bytes already landed for this media).
 */
export async function ingest(settings: MediaSettings, input: IngestInput): Promise<IngestResult> {
	const now = input.now ?? Date.now();

	const tokenId = parseUploadToken(settings.tokenSecret, input.token);
	if (!tokenId) throw rejected();

	// Single use, atomically, and only if unexpired: the winner of a race is the
	// only caller that gets a row back.
	const token = consumeUploadToken(input.db, tokenId, { now });
	if (!token) throw rejected();

	const media = findMediaById(input.db, token.mediaId);
	if (!media) throw mediaNotFound('the media this token was minted for is gone');
	if (media.sha256 !== '') throw mediaConflict('bytes have already landed for this media');

	const allowed = token.mimeAllow.filter(isAllowedMime);
	if (allowed.length === 0) throw unsupportedType('this token authorises no servable type');

	if (input.contentLength != null && input.contentLength > token.maxBytes) {
		// Declared too big. Refused without reading a byte — the only thing
		// `Content-Length` is ever trusted for.
		throw overCap(token.maxBytes);
	}

	if (!input.body) throw mediaInvalid('the request had no body');

	const written = await streamToTempFile(settings, {
		body: input.body,
		maxBytes: token.maxBytes,
		allowed
	});

	const stored = await place(settings, {
		db: input.db,
		media,
		tempPath: written.tempPath,
		mime: written.mime,
		sha256: written.sha256
	});

	const updated = setMediaBytes(input.db, media.id, {
		bytes: written.bytes,
		sha256: written.sha256
	});

	return { media: updated ?? media, deduped: stored.deduped };
}

function rejected() {
	// One message for forged, unknown, expired and spent alike: a caller that can
	// tell them apart can probe for live tokens.
	return tokenRejected(
		'this upload token is not valid: it may be expired, already used, or not one of ours. ' +
			'Call create_upload again for a fresh one.'
	);
}

function overCap(maxBytes: number) {
	return tooLarge(
		`this upload may be at most ${maxBytes} bytes. The token is spent either way: ` +
			`call create_upload again with the real size.`
	);
}

type Written = { tempPath: string; bytes: number; sha256: string; mime: string };

/**
 * Stream the body to a temp file, enforcing the cap and the type as it goes.
 *
 * The head is buffered rather than written so that a body whose type is wrong
 * never becomes a file at all; from the moment the type is confirmed, chunks go
 * straight to disk and only one chunk is ever in memory.
 */
async function streamToTempFile(
	settings: MediaSettings,
	options: { body: ReadableStream<Uint8Array>; maxBytes: number; allowed: readonly string[] }
): Promise<Written> {
	const reader = options.body.getReader();
	const hash = createHash('sha256');
	const head = new Uint8Array(SNIFF_BYTES);

	let headLength = 0;
	let total = 0;
	let mime: string | undefined;
	let handle: FileHandle | undefined;
	let tempPath: string | undefined;

	const write = async (bytes: Uint8Array) => {
		if (bytes.length === 0) return;
		if (!handle) {
			await mkdir(tempUploadRoot(settings), { recursive: true });
			tempPath = tempUploadFile(settings, `${crypto.randomUUID()}.part`);
			handle = await open(tempPath, 'wx');
		}
		await handle.write(bytes);
	};

	/** Judge the head, then commit it to disk. Throws if the bytes are not what was promised. */
	const verify = async () => {
		const sniffed = await sniffMime(head.subarray(0, headLength));
		if (!sniffed || !isAllowedMime(sniffed) || !options.allowed.includes(sniffed)) {
			throw unsupportedType(
				`these bytes are ${sniffed ? JSON.stringify(sniffed) : 'of no recognised type'}, and ` +
					`this upload was reserved for ${options.allowed.join(', ')}. The declared type must ` +
					`match the actual bytes; SVG and anything off the allowlist is never accepted.`
			);
		}
		mime = sniffed;
		await write(head.subarray(0, headLength));
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.length === 0) continue;

			total += value.length;
			if (total > options.maxBytes) throw overCap(options.maxBytes);
			hash.update(value);

			if (mime) {
				await write(value);
				continue;
			}

			const room = SNIFF_BYTES - headLength;
			const take = Math.min(room, value.length);
			head.set(value.subarray(0, take), headLength);
			headLength += take;

			if (headLength === SNIFF_BYTES) {
				await verify();
				await write(value.subarray(take));
			}
		}

		if (total === 0) throw mediaInvalid('the request body was empty');
		// A file smaller than the sniff window: the whole thing is the head.
		if (!mime) await verify();

		await handle?.close();
		handle = undefined;

		return { tempPath: tempPath!, bytes: total, sha256: hash.digest('hex'), mime: mime! };
	} catch (error) {
		// Stop the sender: on a refused upload there is no reason to keep reading.
		await reader.cancel().catch(() => {});
		await handle?.close().catch(() => {});
		if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Put the finished bytes where `/media/:id/:variant` will find them.
 *
 * Dedup is a hard link, not a shared row: two agents that screenshot the same
 * screen get one copy on disk and one media row each, so either can be attached
 * to its own update, and deleting one leaves the other's file intact.
 */
async function place(
	settings: MediaSettings,
	options: { db: Db; media: Media; tempPath: string; mime: string; sha256: string }
): Promise<{ deduped: boolean }> {
	const target = originalFile(settings, options.media.id, options.mime);
	await mkdir(dirname(target), { recursive: true });

	const twin = findMediaBySha256(options.db, options.sha256);
	if (twin && twin.id !== options.media.id && twin.mime === options.mime) {
		try {
			await link(originalFile(settings, twin.id, twin.mime), target);
			await rm(options.tempPath, { force: true });
			return { deduped: true };
		} catch {
			// The twin's file is missing, or the link failed: fall through and keep
			// the bytes we already have. A dedup that cannot happen is not an error.
		}
	}

	await rename(options.tempPath, target);
	return { deduped: false };
}
