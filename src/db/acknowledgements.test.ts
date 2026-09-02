import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import { insertMessage } from './messages';
import { insertTask } from './tasks';
import { listAcknowledgements, upsertAcknowledgement } from './acknowledgements';

/**
 * An agent saying "seen it" / "done" against one thing (migration 013).
 *
 * The invariant worth a test file of its own is the upsert: one row per agent
 * per thing, however many times the agent changes its mind. Everything else
 * here is a consequence of it.
 */
let db: Db;
let agentId: string;
let otherId: string;
let messageId: string;
let taskId: string;

beforeEach(() => {
	db = freshDatabase();
	const projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	agentId = insertAgent(db, { name: 'scout', tokenHash: 'h1' }).id;
	otherId = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;
	messageId = insertMessage(db, { projectId, author: 'human', body: 'have a look' }).id;
	taskId = insertTask(db, { projectId, title: 'do it' }).id;
});

describe('upsertAcknowledgement', () => {
	it('records a state against a message', () => {
		const ack = upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });

		expect(ack).toMatchObject({
			agentId,
			messageId,
			taskId: null,
			state: 'thinking',
			createdAt: 100,
			updatedAt: 100
		});
	});

	it('rewrites the state in place rather than growing a history nobody reads', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });

		const done = upsertAcknowledgement(db, { agentId, messageId, state: 'done', at: 900 });

		expect(done.state).toBe('done');
		expect(listAcknowledgements(db, { messageIds: [messageId] })).toHaveLength(1);
	});

	it('keeps created_at through the rewrite, so "seen then, finished now" survives', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });

		const done = upsertAcknowledgement(db, { agentId, messageId, state: 'done', at: 900 });

		expect(done).toMatchObject({ createdAt: 100, updatedAt: 900 });
	});

	it('gives each agent its own row on the same message', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });
		upsertAcknowledgement(db, { agentId: otherId, messageId, state: 'done', at: 200 });

		expect(listAcknowledgements(db, { messageIds: [messageId] }).map((ack) => ack.state)).toEqual([
			'thinking',
			'done'
		]);
	});

	it('does the same for a task, on its own index', () => {
		upsertAcknowledgement(db, { agentId, taskId, state: 'thinking', at: 100 });
		const done = upsertAcknowledgement(db, { agentId, taskId, state: 'done', at: 200 });

		expect(done).toMatchObject({ taskId, messageId: null, state: 'done', createdAt: 100 });
		expect(listAcknowledgements(db, { taskIds: [taskId] })).toHaveLength(1);
	});

	it('keeps a message acknowledgement and a task one apart', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });
		upsertAcknowledgement(db, { agentId, taskId, state: 'done', at: 100 });

		expect(listAcknowledgements(db, { messageIds: [messageId] })).toHaveLength(1);
		expect(listAcknowledgements(db, { taskIds: [taskId] })).toHaveLength(1);
	});
});

describe('listAcknowledgements', () => {
	it('reads messages and tasks in one query', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });
		upsertAcknowledgement(db, { agentId, taskId, state: 'done', at: 200 });

		expect(listAcknowledgements(db, { messageIds: [messageId], taskIds: [taskId] })).toHaveLength(
			2
		);
	});

	it('answers nothing for a query that named nothing, rather than everything', () => {
		upsertAcknowledgement(db, { agentId, messageId, state: 'thinking', at: 100 });

		expect(listAcknowledgements(db, {})).toEqual([]);
		expect(listAcknowledgements(db, { messageIds: [], taskIds: [] })).toEqual([]);
	});

	it('leaves out things nobody acknowledged', () => {
		expect(listAcknowledgements(db, { messageIds: [messageId] })).toEqual([]);
	});
});
