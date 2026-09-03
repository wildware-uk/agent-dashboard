import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import {
	advanceReadCursor,
	getReadCursor,
	listReadCursors,
	readCursorSeq,
	NO_PROJECT
} from './read-cursors';

let db: Db;
let agentId: string;
let projectId: string;
let otherProjectId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
	projectId = insertProject(db, { slug: 'melon-merge', name: 'Melon Merge' }).id;
	otherProjectId = insertProject(db, { slug: 'dashboard', name: 'Dashboard' }).id;
});

describe('getReadCursor', () => {
	it('is absent until the agent has read something', () => {
		expect(getReadCursor(db, agentId, projectId)).toBeUndefined();
		expect(readCursorSeq(db, agentId, projectId)).toBe(0);
	});
});

describe('advanceReadCursor', () => {
	it('creates the cursor on first read', () => {
		const cursor = advanceReadCursor(db, agentId, projectId, 7);

		expect(cursor).toMatchObject({ agentId, projectId, lastSeenMessageSeq: 7 });
		expect(readCursorSeq(db, agentId, projectId)).toBe(7);
	});

	it('moves forward on a later read', () => {
		advanceReadCursor(db, agentId, projectId, 7);

		expect(advanceReadCursor(db, agentId, projectId, 9)).toMatchObject({ lastSeenMessageSeq: 9 });
	});

	it('never moves backwards, so an out-of-order read cannot resurrect messages', () => {
		advanceReadCursor(db, agentId, projectId, 9);

		expect(advanceReadCursor(db, agentId, projectId, 4)).toMatchObject({ lastSeenMessageSeq: 9 });
	});

	it('keeps one cursor per agent', () => {
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;

		advanceReadCursor(db, agentId, projectId, 5);
		advanceReadCursor(db, other, projectId, 2);

		expect(readCursorSeq(db, agentId, projectId)).toBe(5);
		expect(readCursorSeq(db, other, projectId)).toBe(2);
	});

	it('keeps one cursor per project, so reading here cannot mark there read', () => {
		advanceReadCursor(db, agentId, projectId, 12);

		expect(readCursorSeq(db, agentId, projectId)).toBe(12);
		expect(readCursorSeq(db, agentId, otherProjectId)).toBe(0);
	});

	it('tracks messages that belong to no project in their own bucket', () => {
		advanceReadCursor(db, agentId, NO_PROJECT, 3);

		expect(readCursorSeq(db, agentId)).toBe(3);
		expect(readCursorSeq(db, agentId, projectId)).toBe(0);
	});

	it('will not track an agent that does not exist', () => {
		expect(() => advanceReadCursor(db, 'nobody', projectId, 1)).toThrow(/FOREIGN KEY/);
	});
});

describe('listReadCursors', () => {
	it('answers with every project this agent has read in', () => {
		advanceReadCursor(db, agentId, projectId, 4);
		advanceReadCursor(db, agentId, otherProjectId, 6);

		expect(listReadCursors(db, agentId)).toMatchObject([
			{ projectId, lastSeenMessageSeq: 4 },
			{ projectId: otherProjectId, lastSeenMessageSeq: 6 }
		]);
	});

	it('is empty for an agent that has read nothing', () => {
		expect(listReadCursors(db, agentId)).toEqual([]);
	});
});
