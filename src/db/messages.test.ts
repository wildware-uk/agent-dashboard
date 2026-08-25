import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import { insertUpdate } from './updates';
import { countMessagesAfter, findMessageById, insertMessage, listMessages } from './messages';

let db: Db;
let projectId: string;
let agentId: string;
beforeEach(() => {
	db = freshDatabase();
	projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
});

describe('insertMessage', () => {
	it('stores an owner message against a project', () => {
		const message = insertMessage(db, { projectId, author: 'human', body: 'try again' });

		expect(message).toMatchObject({
			projectId,
			updateId: null,
			taskId: null,
			author: 'human',
			body: 'try again'
		});
		expect(findMessageById(db, message.id)).toEqual(message);
	});

	it('stores an agent reply, whose author names the agent', () => {
		const updateId = insertUpdate(db, { projectId, agentId, body: 'x' }).id;

		expect(
			insertMessage(db, { projectId, updateId, author: `agent:${agentId}`, body: 'done' })
		).toMatchObject({ author: `agent:${agentId}`, updateId });
	});

	it('can be a standalone message with no project at all', () => {
		expect(insertMessage(db, { author: 'human', body: 'hello' })).toMatchObject({
			projectId: null
		});
	});
});

describe('listMessages', () => {
	beforeEach(() => {
		insertMessage(db, { projectId, author: 'human', body: 'one' });
		insertMessage(db, { author: 'human', body: 'two' });
		insertMessage(db, { projectId, author: 'human', body: 'three' });
	});

	it('reads oldest first, because that is the order an agent catches up in', () => {
		expect(listMessages(db).map((m) => m.body)).toEqual(['one', 'two', 'three']);
	});

	it('reads everything after a cursor, which is how unread is computed', () => {
		const all = listMessages(db);

		expect(listMessages(db, { afterSeq: all[0].seq }).map((m) => m.body)).toEqual(['two', 'three']);
		expect(listMessages(db, { afterSeq: all.at(-1)!.seq })).toEqual([]);
	});

	it('filters by project', () => {
		expect(listMessages(db, { projectId }).map((m) => m.body)).toEqual(['one', 'three']);
	});

	it('honours a limit', () => {
		expect(listMessages(db, { limit: 2 }).map((m) => m.body)).toEqual(['one', 'two']);
	});
});

describe('countMessagesAfter', () => {
	it('is the unread count the heartbeat piggybacks', () => {
		insertMessage(db, { projectId, author: 'human', body: 'one' });
		const second = insertMessage(db, { projectId, author: 'human', body: 'two' });
		insertMessage(db, { projectId, author: `agent:${agentId}`, body: 'mine' });

		expect(countMessagesAfter(db, 0)).toBe(3);
		expect(countMessagesAfter(db, second.seq)).toBe(1);
		// An agent does not want its own replies back as unread.
		expect(countMessagesAfter(db, 0, { excludeAuthor: `agent:${agentId}` })).toBe(2);
	});
});
