import {
	attachMediaToUpdate,
	findMediaById,
	findUploadTokenById,
	insertAgent,
	insertProject,
	insertUpdate,
	setMediaStatus,
	type Db
} from '$db';
import { freshDatabase } from '$db/testing';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingest } from './ingest';
import { mediaDir, originalFile } from './paths';
import { ORPHAN_AGE_MS, sweepOrphanedMedia } from './sweeper';
import { parseUploadToken } from './tokens';
import { bodyOf, paddedBytes, pngBytes, tempSettings } from './testing';
import { createUpload } from './upload';

const NOW = Date.UTC(2026, 7, 25, 9, 30, 0);
const HOUR_AGO = NOW - ORPHAN_AGE_MS - 1;

let db: Db;
let agentId: string;
let updateId: string;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'uploader', tokenHash: 'hash' }).id;
	const projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	updateId = insertUpdate(db, { projectId, agentId, body: 'shipped' }).id;
	temp = tempSettings();
	settings = temp.settings;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

/** An upload that really happened, at a chosen moment. */
async function uploadedAt(when: number, bytes = pngBytes()) {
	const created = createUpload(settings, {
		db,
		agentId,
		filename: 'shot.png',
		mime: 'image/png',
		bytes: bytes.length,
		now: when
	});
	await ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: when });
	return created;
}

describe('collecting orphaned media', () => {
	it('takes ready media that no update ever claimed, once it is an hour old', async () => {
		const orphan = await uploadedAt(HOUR_AGO);
		setMediaStatus(db, orphan.mediaId, { status: 'ready' });

		const swept = await sweepOrphanedMedia(settings, { db, now: NOW });

		expect(swept.media).toBe(1);
		expect(findMediaById(db, orphan.mediaId)).toBeUndefined();
		expect(existsSync(mediaDir(settings, orphan.mediaId))).toBe(false);
	});

	it('leaves media an update is using, however old it is', async () => {
		const kept = await uploadedAt(HOUR_AGO);
		setMediaStatus(db, kept.mediaId, { status: 'ready' });
		attachMediaToUpdate(db, { mediaIds: [kept.mediaId], updateId, agentId });

		await sweepOrphanedMedia(settings, { db, now: NOW });

		expect(findMediaById(db, kept.mediaId)).toBeTruthy();
		expect(existsSync(originalFile(settings, kept.mediaId, 'image/png'))).toBe(true);
	});

	it('leaves a recent orphan alone: the update that will claim it may still be coming', async () => {
		const recent = await uploadedAt(NOW - 60_000);
		setMediaStatus(db, recent.mediaId, { status: 'ready' });

		const swept = await sweepOrphanedMedia(settings, { db, now: NOW });

		expect(swept.media).toBe(0);
		expect(findMediaById(db, recent.mediaId)).toBeTruthy();
	});

	it('takes a reservation whose bytes never arrived, and its token with it', async () => {
		const abandoned = createUpload(settings, {
			db,
			agentId,
			filename: 'never-sent.png',
			mime: 'image/png',
			bytes: 4096,
			now: HOUR_AGO
		});
		const tokenId = parseUploadToken(settings.tokenSecret, abandoned.token)!;

		const swept = await sweepOrphanedMedia(settings, { db, now: NOW });

		expect(swept.media).toBe(1);
		expect(findMediaById(db, abandoned.mediaId)).toBeUndefined();
		// Cascaded: a token for media that no longer exists could never be spent.
		expect(findUploadTokenById(db, tokenId)).toBeUndefined();
	});

	it('takes a failed upload, which is nobody`s media either', async () => {
		const failed = await uploadedAt(HOUR_AGO);
		setMediaStatus(db, failed.mediaId, { status: 'failed' });

		expect((await sweepOrphanedMedia(settings, { db, now: NOW })).media).toBe(1);
		expect(findMediaById(db, failed.mediaId)).toBeUndefined();
	});

	it('drops unused tokens that expired, and keeps the record of spent ones', async () => {
		const spent = await uploadedAt(HOUR_AGO);
		setMediaStatus(db, spent.mediaId, { status: 'ready' });
		attachMediaToUpdate(db, { mediaIds: [spent.mediaId], updateId, agentId });
		const unused = createUpload(settings, {
			db,
			agentId,
			filename: 'never-sent.png',
			mime: 'image/png',
			bytes: 10,
			now: HOUR_AGO
		});

		const swept = await sweepOrphanedMedia(settings, { db, now: NOW });

		// The unused token's media row was collected, which takes the token with
		// it; the spent one stays because its media is attached to an update.
		expect(swept.tokens + swept.media).toBeGreaterThanOrEqual(1);
		expect(
			findUploadTokenById(db, parseUploadToken(settings.tokenSecret, unused.token)!)
		).toBeUndefined();
		expect(
			findUploadTokenById(db, parseUploadToken(settings.tokenSecret, spent.token)!)
		).toBeTruthy();
	});

	it('never deletes bytes another media row still shares', async () => {
		const bytes = pngBytes();
		const first = await uploadedAt(HOUR_AGO, bytes);
		const second = await uploadedAt(HOUR_AGO, bytes);
		setMediaStatus(db, first.mediaId, { status: 'ready' });
		setMediaStatus(db, second.mediaId, { status: 'ready' });
		attachMediaToUpdate(db, { mediaIds: [second.mediaId], updateId, agentId });

		await sweepOrphanedMedia(settings, { db, now: NOW });

		// Deduped uploads are hard links, so collecting the orphan drops one name
		// and leaves the attached row's file whole.
		expect(findMediaById(db, first.mediaId)).toBeUndefined();
		expect(
			new Uint8Array(readFileSync(originalFile(settings, second.mediaId, 'image/png')))
		).toEqual(bytes);
	});

	it('sweeps in bounded batches, so one run cannot hold the process', async () => {
		for (let i = 0; i < 3; i += 1) {
			const created = await uploadedAt(HOUR_AGO, paddedBytes(pngBytes(), 128 + i));
			setMediaStatus(db, created.mediaId, { status: 'ready' });
		}

		expect((await sweepOrphanedMedia(settings, { db, now: NOW, limit: 2 })).media).toBe(2);
		expect((await sweepOrphanedMedia(settings, { db, now: NOW, limit: 2 })).media).toBe(1);
		expect((await sweepOrphanedMedia(settings, { db, now: NOW })).media).toBe(0);
	});

	it('collects an hour after creation, as the design says', () => {
		expect(ORPHAN_AGE_MS).toBe(60 * 60 * 1000);
	});
});
