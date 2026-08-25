import { findMediaById, insertAgent, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMediaError, type MediaErrorCode } from './errors';
import { ingest } from './ingest';
import { mediaDir, originalFile, tempUploadRoot } from './paths';
import { signUploadToken } from './tokens';
import {
	bodyOf,
	countingBody,
	gifBytes,
	movBytes,
	mp4Bytes,
	paddedBytes,
	pngBytes,
	svgBytes,
	tempSettings,
	zipBytes
} from './testing';
import { createUpload } from './upload';

const NOW = Date.UTC(2026, 7, 25, 9, 30, 0);

let db: Db;
let agentId: string;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'uploader', tokenHash: 'hash' }).id;
	temp = tempSettings();
	settings = temp.settings;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

/** A reservation, as `create_upload` would have made it. */
function reserve(mime: string, bytes: number) {
	return createUpload(settings, {
		db,
		agentId,
		filename: 'shot.png',
		mime,
		bytes,
		now: NOW
	});
}

/** The code a rejection carried, or `undefined` if the call succeeded. */
async function refusal(body: () => Promise<unknown>): Promise<MediaErrorCode | undefined> {
	try {
		await body();
		return undefined;
	} catch (error) {
		if (!isMediaError(error)) throw error;
		return error.code;
	}
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const tempFiles = () => {
	try {
		return readdirSync(tempUploadRoot(settings));
	} catch {
		return [];
	}
};

describe('a well-behaved upload', () => {
	it('stores the bytes, records what really arrived, and leaves the row pending', async () => {
		const bytes = pngBytes();
		const created = reserve('image/png', bytes.length);

		const result = await ingest(settings, {
			db,
			token: created.token,
			body: bodyOf(bytes),
			contentLength: bytes.length,
			now: NOW
		});

		expect(result.deduped).toBe(false);
		expect(result.media.bytes).toBe(bytes.length);
		expect(result.media.sha256).toBe(sha256(bytes));
		// Flipping to `ready` and publishing `media.ready` is the derivative
		// pipeline's job (design §6 step 5), not the upload's.
		expect(result.media.status).toBe('pending');
		expect(findMediaById(db, created.mediaId)!.sha256).toBe(sha256(bytes));
	});

	it('writes it to data/media/<id[0:2]>/<id>/original.ext and nowhere else', async () => {
		const bytes = pngBytes();
		const created = reserve('image/png', bytes.length);

		await ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW });

		const file = originalFile(settings, created.mediaId, 'image/png');

		expect(file).toBe(`${mediaDir(settings, created.mediaId)}/original.png`);
		expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
		expect(readdirSync(mediaDir(settings, created.mediaId))).toEqual(['original.png']);
		expect(tempFiles()).toEqual([]);
	});

	it('names a video by its real container', async () => {
		const bytes = movBytes();
		const created = reserve('video/quicktime', bytes.length);

		await ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW });

		expect(readdirSync(mediaDir(settings, created.mediaId))).toEqual(['original.mov']);
	});

	it('accepts an mp4', async () => {
		const bytes = mp4Bytes();
		const created = reserve('video/mp4', bytes.length);

		const result = await ingest(settings, {
			db,
			token: created.token,
			body: bodyOf(bytes),
			now: NOW
		});

		expect(result.media.kind).toBe('video');
		expect(readdirSync(mediaDir(settings, created.mediaId))).toEqual(['original.mp4']);
	});
});

describe('bytes that are not what they claim to be', () => {
	it('rejects a zip renamed to .png', async () => {
		const bytes = zipBytes();
		const created = reserve('image/png', bytes.length);

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW })
			)
		).toBe('unsupported_type');

		expect(() => readdirSync(mediaDir(settings, created.mediaId))).toThrow();
		expect(tempFiles()).toEqual([]);
		expect(findMediaById(db, created.mediaId)!.sha256).toBe('');
	});

	it('rejects an SVG smuggled in behind an image/png reservation', async () => {
		const bytes = svgBytes();
		const created = reserve('image/png', bytes.length);

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW })
			)
		).toBe('unsupported_type');
		expect(tempFiles()).toEqual([]);
	});

	it('rejects a real image of the wrong type: the reservation said png, these bytes are gif', async () => {
		const bytes = gifBytes();
		const created = reserve('image/png', bytes.length);

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW })
			)
		).toBe('unsupported_type');
	});

	it('rejects an empty body rather than storing a zero-byte file', async () => {
		const created = reserve('image/png', 64);

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: bodyOf(new Uint8Array(0)), now: NOW })
			)
		).toBe('invalid_argument');
		expect(tempFiles()).toEqual([]);
	});

	it('rejects a missing body', async () => {
		const created = reserve('image/png', 64);

		expect(
			await refusal(() => ingest(settings, { db, token: created.token, body: null, now: NOW }))
		).toBe('invalid_argument');
	});
});

describe('the byte cap', () => {
	it('cuts the body off mid-stream instead of buffering it and then measuring', async () => {
		const cap = 1024;
		const created = reserve('image/png', cap);
		const body = countingBody(paddedBytes(pngBytes(), 64 * 1024), 256);

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: body.stream, now: NOW })
			)
		).toBe('too_large');

		// The whole point: the writer stopped as soon as the cap was passed, so
		// only a little over the cap was ever pulled off the socket.
		expect(body.pulled()).toBeLessThanOrEqual(cap + 256);
		expect(body.pulled()).toBeLessThan(64 * 1024);
		expect(body.cancelled()).toBe(true);
		expect(tempFiles()).toEqual([]);
		expect(() => readdirSync(mediaDir(settings, created.mediaId))).toThrow();
	});

	it('does not trust Content-Length: a truthful header just saves the transfer', async () => {
		const created = reserve('image/png', 1024);
		const body = countingBody(paddedBytes(pngBytes(), 64 * 1024), 256);

		expect(
			await refusal(() =>
				ingest(settings, {
					db,
					token: created.token,
					body: body.stream,
					contentLength: 64 * 1024,
					now: NOW
				})
			)
		).toBe('too_large');

		// Declared too big, so not a single byte was read.
		expect(body.pulled()).toBe(0);
	});

	it('is the cap the token was minted with, not the size of the body claimed later', async () => {
		const created = reserve('image/png', 1024);
		const body = countingBody(paddedBytes(pngBytes(), 4096), 256);

		expect(
			await refusal(() =>
				ingest(settings, {
					db,
					token: created.token,
					body: body.stream,
					// A lie in the other direction: small header, large body.
					contentLength: 10,
					now: NOW
				})
			)
		).toBe('too_large');
	});
});

describe('the token', () => {
	it('works exactly once', async () => {
		const bytes = pngBytes();
		const created = reserve('image/png', bytes.length);

		await ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW });

		expect(
			await refusal(() =>
				ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW })
			)
		).toBe('token_rejected');
	});

	it('is refused once its fifteen minutes are up', async () => {
		const bytes = pngBytes();
		const created = reserve('image/png', bytes.length);

		expect(
			await refusal(() =>
				ingest(settings, {
					db,
					token: created.token,
					body: bodyOf(bytes),
					now: created.expiresAt + 1
				})
			)
		).toBe('token_rejected');
		expect(findMediaById(db, created.mediaId)!.sha256).toBe('');
	});

	it('is refused when forged, malformed or unknown, without reading the body', async () => {
		const bytes = pngBytes();
		const created = reserve('image/png', bytes.length);
		const [id, signature] = created.token.split('.');

		for (const token of [
			'',
			'nonsense',
			id,
			`${id}.${signature.slice(0, -1)}A`,
			signUploadToken('a-different-secret-of-sufficient-length', id)
		]) {
			const body = countingBody(bytes, 16);

			expect(
				await refusal(() => ingest(settings, { db, token, body: body.stream, now: NOW })),
				JSON.stringify(token)
			).toBe('token_rejected');
			expect(body.pulled(), JSON.stringify(token)).toBe(0);
		}
	});
});

describe('identical bytes', () => {
	it('are stored once: the second upload shares the first file', async () => {
		const bytes = pngBytes();
		const first = reserve('image/png', bytes.length);
		const second = reserve('image/png', bytes.length);

		const one = await ingest(settings, {
			db,
			token: first.token,
			body: bodyOf(bytes),
			now: NOW
		});
		const two = await ingest(settings, {
			db,
			token: second.token,
			body: bodyOf(bytes),
			now: NOW
		});

		expect(two.deduped).toBe(true);
		expect(one.media.sha256).toBe(two.media.sha256);
		expect(one.media.id).not.toBe(two.media.id);

		const a = statSync(originalFile(settings, one.media.id, 'image/png'));
		const b = statSync(originalFile(settings, two.media.id, 'image/png'));

		// One inode, two names: each media row is independently addressable and
		// independently deletable, and the bytes are on disk once.
		expect(b.ino).toBe(a.ino);
		expect(b.nlink).toBe(2);
		expect(new Uint8Array(readFileSync(originalFile(settings, two.media.id, 'image/png')))).toEqual(
			bytes
		);
	});

	it('are stored separately when the bytes differ by one', async () => {
		const bytes = pngBytes();
		const other = paddedBytes(bytes, bytes.length + 1);
		const first = reserve('image/png', bytes.length);
		const second = reserve('image/png', other.length);

		const one = await ingest(settings, { db, token: first.token, body: bodyOf(bytes), now: NOW });
		const two = await ingest(settings, { db, token: second.token, body: bodyOf(other), now: NOW });

		expect(two.deduped).toBe(false);
		expect(one.media.sha256).not.toBe(two.media.sha256);
		expect(statSync(originalFile(settings, two.media.id, 'image/png')).nlink).toBe(1);
	});
});
