import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import { insertUpdate } from './updates';
import {
	attachMediaToUpdate,
	deleteMedia,
	findMediaById,
	findMediaBySha256,
	insertMedia,
	listMediaByStatus,
	listMediaForUpdate,
	listOrphanedMedia,
	setMediaBytes,
	setMediaStatus
} from './media';

let db: Db;
let agentId: string;
let updateId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
	const projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	updateId = insertUpdate(db, { projectId, agentId, body: 'x' }).id;
});

const upload = (over: Partial<Parameters<typeof insertMedia>[1]> = {}) =>
	insertMedia(db, {
		agentId,
		kind: 'image',
		mime: 'image/png',
		bytes: 1024,
		sha256: 'abc',
		...over
	});

describe('insertMedia', () => {
	it('starts pending and unattached, because upload precedes the update', () => {
		const media = upload();

		expect(media).toMatchObject({
			agentId,
			updateId: null,
			kind: 'image',
			mime: 'image/png',
			bytes: 1024,
			sha256: 'abc',
			status: 'pending',
			width: null,
			height: null,
			durationMs: null
		});
	});

	it('rejects a kind outside image or video', () => {
		expect(() => upload({ kind: 'audio' as 'image' })).toThrow(/CHECK/);
	});
});

describe('setMediaStatus', () => {
	it('flips to ready with the dimensions the pipeline measured', () => {
		const media = upload();

		const ready = setMediaStatus(db, media.id, {
			status: 'ready',
			width: 1600,
			height: 900
		});

		expect(ready).toMatchObject({ status: 'ready', width: 1600, height: 900 });
	});

	it('records a duration for video', () => {
		const media = upload({ kind: 'video', mime: 'video/mp4' });

		expect(setMediaStatus(db, media.id, { status: 'ready', durationMs: 1500 })).toMatchObject({
			durationMs: 1500
		});
	});

	it('can fail a media item, and returns undefined for a stranger', () => {
		const media = upload();

		expect(setMediaStatus(db, media.id, { status: 'failed' })).toMatchObject({
			status: 'failed'
		});
		expect(setMediaStatus(db, 'nope', { status: 'ready' })).toBeUndefined();
	});
});

describe('attachMediaToUpdate', () => {
	it('attaches only unattached media belonging to that agent', () => {
		const mine = upload();
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;
		const theirs = upload({ agentId: other });

		const attached = attachMediaToUpdate(db, {
			mediaIds: [mine.id, theirs.id],
			updateId,
			agentId
		});

		expect(attached).toEqual([mine.id]);
		expect(findMediaById(db, mine.id)).toMatchObject({ updateId });
		expect(findMediaById(db, theirs.id)).toMatchObject({ updateId: null });
	});

	it('will not steal media that is already on another update', () => {
		const media = upload();
		attachMediaToUpdate(db, { mediaIds: [media.id], updateId, agentId });

		const attached = attachMediaToUpdate(db, {
			mediaIds: [media.id],
			updateId,
			agentId
		});

		expect(attached).toEqual([]);
	});

	it('does nothing when given no ids', () => {
		expect(attachMediaToUpdate(db, { mediaIds: [], updateId, agentId })).toEqual([]);
	});
});

describe('listMediaForUpdate', () => {
	it('returns the update`s media in upload order', () => {
		const first = upload();
		const second = upload({ sha256: 'def' });
		upload({ sha256: 'ghi' });
		attachMediaToUpdate(db, { mediaIds: [first.id, second.id], updateId, agentId });

		expect(listMediaForUpdate(db, updateId).map((m) => m.id)).toEqual([first.id, second.id]);
	});
});

describe('findMediaBySha256', () => {
	it('is the dedup lookup, newest first', () => {
		upload({ sha256: 'same', createdAt: 1 });
		const newer = upload({ sha256: 'same', createdAt: 2 });

		expect(findMediaBySha256(db, 'same')!.id).toBe(newer.id);
		expect(findMediaBySha256(db, 'other')).toBeUndefined();
	});
});

describe('listOrphanedMedia', () => {
	it('finds ready media that no update ever claimed, older than the cutoff', () => {
		const orphan = upload({ createdAt: 100 });
		setMediaStatus(db, orphan.id, { status: 'ready' });
		const recent = upload({ sha256: 'b', createdAt: 5000 });
		setMediaStatus(db, recent.id, { status: 'ready' });
		const attached = upload({ sha256: 'c', createdAt: 100 });
		setMediaStatus(db, attached.id, { status: 'ready' });
		attachMediaToUpdate(db, { mediaIds: [attached.id], updateId, agentId });
		const pending = upload({ sha256: 'd', createdAt: 100 });

		const orphans = listOrphanedMedia(db, { createdBefore: 1000 }).map((m) => m.id);

		expect(orphans).toEqual([orphan.id]);
		expect(orphans).not.toContain(recent.id);
		expect(orphans).not.toContain(attached.id);
		expect(orphans).not.toContain(pending.id);
	});

	it('includes failed uploads, which are also nobody`s media', () => {
		const failed = upload({ createdAt: 100 });
		setMediaStatus(db, failed.id, { status: 'failed' });

		expect(
			listOrphanedMedia(db, { createdBefore: 1000, statuses: ['ready', 'failed'] }).map((m) => m.id)
		).toEqual([failed.id]);
	});
});

describe('setMediaBytes', () => {
	it('records what actually arrived, which is not what was declared', () => {
		const media = upload({ bytes: 4096, sha256: '' });

		const stored = setMediaBytes(db, media.id, { bytes: 1234, sha256: 'deadbeef' })!;

		expect(stored.bytes).toBe(1234);
		expect(stored.sha256).toBe('deadbeef');
		// Untouched: flipping to ready is the derivative pipeline's call, not the
		// ingest's (design §6 step 5).
		expect(stored.status).toBe('pending');
		expect(findMediaById(db, media.id)!.sha256).toBe('deadbeef');
	});

	it('answers with nothing for an id that is not there', () => {
		expect(setMediaBytes(db, 'nope', { bytes: 1, sha256: 'x' })).toBeUndefined();
	});
});

describe('deleteMedia', () => {
	it('removes the row for good, because the bytes are gone too', () => {
		const media = upload();

		expect(deleteMedia(db, media.id)).toBe(true);
		expect(findMediaById(db, media.id)).toBeUndefined();
		expect(deleteMedia(db, media.id)).toBe(false);
	});
});

describe('listMediaByStatus', () => {
	it('finds the rows in one state, oldest first', () => {
		const first = upload();
		const second = upload();
		upload({ status: 'ready' });

		expect(listMediaByStatus(db, { statuses: ['pending'] }).map((row) => row.id)).toEqual([
			first.id,
			second.id
		]);
	});

	it('takes more than one state at a time', () => {
		const pending = upload();
		const failed = upload({ status: 'failed' });
		upload({ status: 'ready' });

		expect(
			listMediaByStatus(db, { statuses: ['pending', 'failed'] })
				.map((row) => row.id)
				.sort()
		).toEqual([pending.id, failed.id].sort());
	});

	it('can leave out reservations whose bytes never arrived', () => {
		const landed = upload();
		upload({ sha256: '' });

		expect(listMediaByStatus(db, { statuses: ['pending'], hasBytes: true })).toEqual([landed]);
		expect(listMediaByStatus(db, { statuses: ['pending'] })).toHaveLength(2);
	});

	it('is bounded', () => {
		upload();
		upload();

		expect(listMediaByStatus(db, { statuses: ['pending'], limit: 1 })).toHaveLength(1);
	});

	it('answers with nothing when no state is asked for', () => {
		upload();

		expect(listMediaByStatus(db, { statuses: [] })).toEqual([]);
	});
});
