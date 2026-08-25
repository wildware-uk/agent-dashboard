import { findMediaById, findUploadTokenById, insertAgent, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMediaError, type MediaErrorCode } from './errors';
import { createUpload } from './upload';
import { UPLOAD_TOKEN_TTL_MS, parseUploadToken } from './tokens';
import { tempSettings } from './testing';

const NOW = Date.UTC(2026, 7, 25, 9, 30, 0);

let db: Db;
let agentId: string;
const temp = tempSettings();
const { settings } = temp;

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'ingest-tester', tokenHash: 'hash' }).id;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

/** The code a refusal carried, so a test can name it instead of matching a message. */
function refusal(body: () => unknown): MediaErrorCode | undefined {
	try {
		body();
		return undefined;
	} catch (error) {
		return isMediaError(error) ? error.code : undefined;
	}
}

const mint = (overrides: Partial<Parameters<typeof createUpload>[1]> = {}) =>
	createUpload(settings, {
		db,
		agentId,
		filename: 'screenshot.png',
		mime: 'image/png',
		bytes: 1024,
		now: NOW,
		...overrides
	});

describe('minting an upload', () => {
	it('hands back an absolute URL, a deadline and a cap', () => {
		const created = mint();

		expect(created.uploadUrl).toBe(`${settings.baseUrl}/api/upload/${created.token}`);
		expect(created.expiresAt).toBe(NOW + UPLOAD_TOKEN_TTL_MS);
		expect(created.maxBytes).toBe(1024);
		expect(parseUploadToken(settings.tokenSecret, created.token)).toBeTruthy();
	});

	it('reserves a pending media row that belongs to the calling agent and no update', () => {
		const created = mint();
		const media = findMediaById(db, created.mediaId)!;

		expect(media.status).toBe('pending');
		expect(media.agentId).toBe(agentId);
		expect(media.updateId).toBeNull();
		expect(media.kind).toBe('image');
		expect(media.mime).toBe('image/png');
		expect(media.sha256).toBe('');
	});

	it('writes the cap and the one allowed type onto the token row, not into the token', () => {
		const created = mint({ mime: 'video/mp4', bytes: 2048 });
		const id = parseUploadToken(settings.tokenSecret, created.token)!;
		const token = findUploadTokenById(db, id)!;

		expect(token.agentId).toBe(agentId);
		expect(token.mediaId).toBe(created.mediaId);
		expect(token.maxBytes).toBe(2048);
		expect(token.mimeAllow).toEqual(['video/mp4']);
		expect(token.expiresAt).toBe(NOW + UPLOAD_TOKEN_TTL_MS);
		expect(token.usedAt).toBeNull();
	});

	it('normalises the declared type before the allowlist sees it', () => {
		const created = mint({ mime: ' IMAGE/PNG; charset=binary ' });

		expect(findMediaById(db, created.mediaId)!.mime).toBe('image/png');
	});

	it('ignores the filename entirely: it names nothing on disk and is stored nowhere', () => {
		const created = mint({ filename: '../../../etc/passwd' });

		// Accepted as a label, but it reaches no column and no path: the extension
		// comes from the mime (design §6), so there is nothing here to escape with.
		expect(findMediaById(db, created.mediaId)!.mime).toBe('image/png');
		expect(JSON.stringify(created)).not.toContain('passwd');
	});
});

describe('what minting refuses', () => {
	it('refuses SVG, whatever else is true about the request', () => {
		expect(refusal(() => mint({ mime: 'image/svg+xml', filename: 'diagram.svg' }))).toBe(
			'unsupported_type'
		);
	});

	it('refuses every type outside the allowlist', () => {
		for (const mime of ['application/zip', 'text/html', 'application/pdf', 'image/*', '']) {
			expect(
				refusal(() => mint({ mime })),
				mime
			).toBe('unsupported_type');
		}
	});

	it('refuses a size that is not a positive whole number of bytes', () => {
		for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				refusal(() => mint({ bytes })),
				String(bytes)
			).toBe('invalid_argument');
		}
	});

	it('refuses a filename that is empty, enormous, or carrying control characters', () => {
		expect(refusal(() => mint({ filename: '   ' }))).toBe('invalid_argument');
		expect(refusal(() => mint({ filename: 'a'.repeat(400) }))).toBe('invalid_argument');
		expect(refusal(() => mint({ filename: 'shot\u0000.png' }))).toBe('invalid_argument');
		expect(refusal(() => mint({ filename: 'shot\n.png' }))).toBe('invalid_argument');
	});

	it('accepts the filenames real screenshots have', () => {
		for (const filename of ['Screen Shot 2026-08-25 at 09.30.00.png', 'a b (1).png']) {
			expect(
				refusal(() => mint({ filename })),
				filename
			).toBeUndefined();
		}
	});

	it('refuses an image over MAX_IMAGE_BYTES and a video over MAX_VIDEO_BYTES', () => {
		expect(refusal(() => mint({ bytes: settings.maxImageBytes + 1 }))).toBe('too_large');
		expect(refusal(() => mint({ mime: 'video/mp4', bytes: settings.maxVideoBytes + 1 }))).toBe(
			'too_large'
		);
	});

	it('caps video by the video limit, so a video larger than the image cap is fine', () => {
		const created = mint({ mime: 'video/mp4', bytes: settings.maxImageBytes + 1 });

		expect(created.maxBytes).toBe(settings.maxImageBytes + 1);
	});

	it('leaves nothing behind when it refuses', () => {
		refusal(() => mint({ mime: 'image/svg+xml' }));

		expect(db.prepare('SELECT count(*) AS n FROM media').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT count(*) AS n FROM upload_tokens').get()).toEqual({ n: 0 });
	});
});
