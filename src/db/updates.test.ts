import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import { insertSession } from './sessions';
import {
	editUpdate,
	findUpdateById,
	insertUpdate,
	listUpdates,
	setUpdatePinned,
	softDeleteUpdate
} from './updates';

let db: Db;
let projectId: string;
let agentId: string;
beforeEach(() => {
	db = freshDatabase();
	projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
});

const post = (body: string, over: Partial<Parameters<typeof insertUpdate>[1]> = {}) =>
	insertUpdate(db, { projectId, agentId, body, ...over });

describe('insertUpdate', () => {
	it('defaults to an info level, unpinned, undeleted update', () => {
		const update = post('shipped it');

		expect(update).toMatchObject({
			projectId,
			agentId,
			sessionId: null,
			title: null,
			body: 'shipped it',
			level: 'info',
			pinned: false,
			deletedAt: null
		});
	});

	it('records the session the update came from', () => {
		const sessionId = insertSession(db, { agentId }).id;

		expect(post('x', { sessionId })).toMatchObject({ sessionId });
	});

	it('rejects a level outside the design enumeration', () => {
		expect(() => post('x', { level: 'shouting' as 'info' })).toThrow(/CHECK/);
	});

	it('rejects an update for a project that does not exist', () => {
		expect(() => insertUpdate(db, { projectId: 'nope', agentId, body: 'x' })).toThrow(
			/FOREIGN KEY/
		);
	});
});

describe('listUpdates', () => {
	beforeEach(() => {
		post('one', { createdAt: 1 });
		post('two', { createdAt: 2 });
		post('three', { createdAt: 3, level: 'error' });
	});

	it('returns the timeline newest first', () => {
		expect(listUpdates(db).map((u) => u.body)).toEqual(['three', 'two', 'one']);
	});

	it('pages backwards with beforeSeq and limit', () => {
		const page = listUpdates(db, { limit: 2 });
		const next = listUpdates(db, { limit: 2, beforeSeq: page.at(-1)!.seq });

		expect(page.map((u) => u.body)).toEqual(['three', 'two']);
		expect(next.map((u) => u.body)).toEqual(['one']);
	});

	it('catches up forwards with afterSeq', () => {
		const all = listUpdates(db);

		expect(listUpdates(db, { afterSeq: all.at(-1)!.seq }).map((u) => u.body)).toEqual([
			'three',
			'two'
		]);
	});

	it('filters by project and by agent', () => {
		const other = insertProject(db, { slug: 'q', name: 'Q' }).id;
		insertUpdate(db, { projectId: other, agentId, body: 'elsewhere' });

		expect(listUpdates(db, { projectId }).map((u) => u.body)).toEqual(['three', 'two', 'one']);
		expect(listUpdates(db, { projectId: other }).map((u) => u.body)).toEqual(['elsewhere']);
		expect(listUpdates(db, { agentId }).length).toBe(4);
	});

	it('hides soft-deleted updates unless they are asked for', () => {
		const doomed = listUpdates(db)[0];
		softDeleteUpdate(db, doomed.id, 500);

		expect(listUpdates(db).map((u) => u.body)).toEqual(['two', 'one']);
		expect(listUpdates(db, { includeDeleted: true }).map((u) => u.body)).toEqual([
			'three',
			'two',
			'one'
		]);
	});
});

describe('softDeleteUpdate', () => {
	it('stamps deleted_at rather than removing the row', () => {
		const update = post('doomed');

		expect(softDeleteUpdate(db, update.id, 500)).toBe(true);
		expect(findUpdateById(db, update.id)).toMatchObject({ deletedAt: 500, body: 'doomed' });
	});

	it('deletes only once', () => {
		const update = post('doomed');
		softDeleteUpdate(db, update.id, 500);

		expect(softDeleteUpdate(db, update.id, 900)).toBe(false);
		expect(findUpdateById(db, update.id)).toMatchObject({ deletedAt: 500 });
	});
});

describe('setUpdatePinned', () => {
	it('pins and unpins', () => {
		const update = post('keep me');

		expect(setUpdatePinned(db, update.id, true)).toMatchObject({ pinned: true });
		expect(setUpdatePinned(db, update.id, false)).toMatchObject({ pinned: false });
		expect(setUpdatePinned(db, 'nope', true)).toBeUndefined();
	});
});

describe('editUpdate', () => {
	const post = (over: Record<string, unknown> = {}) =>
		insertUpdate(db, { projectId, agentId, body: 'deploying', ...over });

	it('writes only the fields the edit names, and always the stamp', () => {
		const update = post({ title: 'release', level: 'warn' });

		const edited = editUpdate(db, update.id, { body: 'deployed', editedAt: 7000 });

		expect(edited).toMatchObject({
			body: 'deployed',
			title: 'release',
			level: 'warn',
			editedAt: 7000
		});
	});

	it('clears a title when the edit passes null', () => {
		const update = post({ title: 'release' });

		expect(editUpdate(db, update.id, { title: null, editedAt: 1 })?.title).toBeNull();
	});

	it('leaves created_at and pinned where they were', () => {
		const update = post({ createdAt: 500 });
		setUpdatePinned(db, update.id, true);

		expect(editUpdate(db, update.id, { body: 'x', editedAt: 9000 })).toMatchObject({
			createdAt: 500,
			pinned: true
		});
	});

	it('will not touch a soft-deleted row', () => {
		const update = post();
		softDeleteUpdate(db, update.id);

		expect(editUpdate(db, update.id, { body: 'back', editedAt: 1 })).toBeUndefined();
		expect(findUpdateById(db, update.id)?.body).toBe('deploying');
	});

	it('says nothing happened for an id that is not there', () => {
		expect(editUpdate(db, 'missing', { body: 'x', editedAt: 1 })).toBeUndefined();
	});

	it('starts every update unedited', () => {
		expect(post().editedAt).toBeNull();
	});
});
