import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import { insertMessage } from './messages';
import { insertUpdate } from './updates';
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
let updateId: string;

beforeEach(() => {
	db = freshDatabase();
	const projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	agentId = insertAgent(db, { name: 'scout', tokenHash: 'h1' }).id;
	otherId = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;
	messageId = insertMessage(db, { projectId, author: 'human', body: 'have a look' }).id;
	updateId = insertUpdate(db, { projectId, agentId, body: 'shipped' }).id;
});

describe('upsertAcknowledgement', () => {
	it('records a state against a message', () => {
		const ack = upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});

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
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});

		const done = upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'done',
			at: 900
		});

		expect(done.state).toBe('done');
		expect(listAcknowledgements(db, { message: [messageId] })).toHaveLength(1);
	});

	it('keeps created_at through the rewrite, so "seen then, finished now" survives', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});

		const done = upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'done',
			at: 900
		});

		expect(done).toMatchObject({ createdAt: 100, updatedAt: 900 });
	});

	it('gives each agent its own row on the same message', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});
		upsertAcknowledgement(db, {
			agentId: otherId,
			card: { kind: 'message', id: messageId },
			state: 'done',
			at: 200
		});

		expect(listAcknowledgements(db, { message: [messageId] }).map((ack) => ack.state)).toEqual([
			'thinking',
			'done'
		]);
	});

	it('does the same for an update, on its own index', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'update', id: updateId },
			state: 'thinking',
			at: 100
		});
		const done = upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'update', id: updateId },
			state: 'done',
			at: 200
		});

		expect(done).toMatchObject({ updateId, messageId: null, state: 'done', createdAt: 100 });
		expect(listAcknowledgements(db, { update: [updateId] })).toHaveLength(1);
	});

	it('keeps a message acknowledgement and an update one apart', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'update', id: updateId },
			state: 'done',
			at: 100
		});

		expect(listAcknowledgements(db, { message: [messageId] })).toHaveLength(1);
		expect(listAcknowledgements(db, { update: [updateId] })).toHaveLength(1);
	});
});

describe('listAcknowledgements', () => {
	it('reads messages and updates in one query', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'update', id: updateId },
			state: 'done',
			at: 200
		});

		expect(listAcknowledgements(db, { message: [messageId], update: [updateId] })).toHaveLength(2);
	});

	it('answers nothing for a query that named nothing, rather than everything', () => {
		upsertAcknowledgement(db, {
			agentId,
			card: { kind: 'message', id: messageId },
			state: 'thinking',
			at: 100
		});

		expect(listAcknowledgements(db, {})).toEqual([]);
		expect(listAcknowledgements(db, { message: [], update: [] })).toEqual([]);
	});

	it('leaves out things nobody acknowledged', () => {
		expect(listAcknowledgements(db, { message: [messageId] })).toEqual([]);
	});
});
