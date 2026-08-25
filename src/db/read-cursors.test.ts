import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { advanceReadCursor, getReadCursor, readCursorSeq } from './read-cursors';

let db: Db;
let agentId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
});

describe('getReadCursor', () => {
	it('is absent until the agent has read something', () => {
		expect(getReadCursor(db, agentId)).toBeUndefined();
		expect(readCursorSeq(db, agentId)).toBe(0);
	});
});

describe('advanceReadCursor', () => {
	it('creates the cursor on first read', () => {
		const cursor = advanceReadCursor(db, agentId, 7);

		expect(cursor).toMatchObject({ agentId, lastSeenMessageSeq: 7 });
		expect(readCursorSeq(db, agentId)).toBe(7);
	});

	it('moves forward on a later read', () => {
		advanceReadCursor(db, agentId, 7);

		expect(advanceReadCursor(db, agentId, 9)).toMatchObject({ lastSeenMessageSeq: 9 });
	});

	it('never moves backwards, so an out-of-order read cannot resurrect messages', () => {
		advanceReadCursor(db, agentId, 9);

		expect(advanceReadCursor(db, agentId, 4)).toMatchObject({ lastSeenMessageSeq: 9 });
	});

	it('keeps one cursor per agent', () => {
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;

		advanceReadCursor(db, agentId, 5);
		advanceReadCursor(db, other, 2);

		expect(readCursorSeq(db, agentId)).toBe(5);
		expect(readCursorSeq(db, other)).toBe(2);
	});

	it('will not track an agent that does not exist', () => {
		expect(() => advanceReadCursor(db, 'nobody', 1)).toThrow(/FOREIGN KEY/);
	});
});
