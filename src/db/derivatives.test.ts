import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { deleteMedia, insertMedia } from './media';
import {
	deleteDerivatives,
	findDerivative,
	insertDerivative,
	listDerivatives,
	upsertDerivative
} from './derivatives';

let db: Db;
let mediaId: string;
beforeEach(() => {
	db = freshDatabase();
	const agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
	mediaId = insertMedia(db, {
		agentId,
		kind: 'image',
		mime: 'image/png',
		bytes: 10,
		sha256: 'abc'
	}).id;
});

describe('insertDerivative', () => {
	it('stores a path relative to the media root', () => {
		const derivative = insertDerivative(db, {
			mediaId,
			kind: 'thumb',
			path: 'ab/abc/thumb-640.webp',
			bytes: 900,
			width: 640,
			height: 360
		});

		expect(derivative).toMatchObject({
			mediaId,
			kind: 'thumb',
			path: 'ab/abc/thumb-640.webp',
			bytes: 900,
			width: 640
		});
	});

	it('allows the same kind at two widths, which is what thumbs are', () => {
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'a', bytes: 1, width: 640 });
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'b', bytes: 2, width: 1600 });

		expect(listDerivatives(db, mediaId)).toHaveLength(2);
	});

	it('refuses the same kind at the same width twice', () => {
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'a', bytes: 1, width: 640 });

		expect(() =>
			insertDerivative(db, { mediaId, kind: 'thumb', path: 'b', bytes: 2, width: 640 })
		).toThrow(/UNIQUE/);
	});

	it('rejects a kind outside the design enumeration', () => {
		expect(() =>
			insertDerivative(db, { mediaId, kind: 'gif' as 'thumb', path: 'a', bytes: 1 })
		).toThrow(/CHECK/);
	});
});

describe('upsertDerivative', () => {
	it('replaces a derivative the pipeline has produced again', () => {
		insertDerivative(db, { mediaId, kind: 'poster', path: 'old.jpg', bytes: 1 });

		const again = upsertDerivative(db, { mediaId, kind: 'poster', path: 'new.jpg', bytes: 2 });

		expect(again).toMatchObject({ path: 'new.jpg', bytes: 2 });
		expect(listDerivatives(db, mediaId)).toHaveLength(1);
	});
});

describe('findDerivative', () => {
	it('is the media serving lookup: one media, one variant', () => {
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'a', bytes: 1, width: 640 });
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'b', bytes: 2, width: 1600 });

		expect(findDerivative(db, mediaId, 'thumb', 1600)).toMatchObject({ path: 'b' });
		expect(findDerivative(db, mediaId, 'poster')).toBeUndefined();
	});
});

describe('cascade', () => {
	it('takes derivatives with the media row when it is deleted', () => {
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'a', bytes: 1, width: 640 });

		deleteMedia(db, mediaId);

		expect(listDerivatives(db, mediaId)).toEqual([]);
	});

	it('can also be cleared without deleting the media', () => {
		insertDerivative(db, { mediaId, kind: 'thumb', path: 'a', bytes: 1, width: 640 });

		expect(deleteDerivatives(db, mediaId)).toBe(1);
		expect(listDerivatives(db, mediaId)).toEqual([]);
	});
});
