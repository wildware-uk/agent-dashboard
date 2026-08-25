import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import {
	endSession,
	endStaleSessions,
	findSessionById,
	heartbeatSession,
	insertSession,
	listLiveSessions,
	listSessionsForAgent
} from './sessions';

let db: Db;
let agentId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
});

describe('insertSession', () => {
	it('opens a session with its first heartbeat already recorded', () => {
		const session = insertSession(db, { agentId, startedAt: 100 });

		expect(session).toMatchObject({
			agentId,
			startedAt: 100,
			lastHeartbeatAt: 100,
			endedAt: null,
			meta: null
		});
	});

	it('round-trips the meta the agent reported', () => {
		const meta = { host: 'box', cwd: '/srv/app', model: 'opus' };

		const session = insertSession(db, { agentId, meta });

		expect(findSessionById(db, session.id)!.meta).toEqual(meta);
	});

	it('will not open a session for an agent that does not exist', () => {
		expect(() => insertSession(db, { agentId: 'nobody' })).toThrow(/FOREIGN KEY/);
	});
});

describe('heartbeatSession', () => {
	it('moves the heartbeat forward and says it did', () => {
		const session = insertSession(db, { agentId, startedAt: 100 });

		expect(heartbeatSession(db, session.id, 200)).toBe(true);
		expect(findSessionById(db, session.id)).toMatchObject({ lastHeartbeatAt: 200 });
	});

	it('refuses to beat a session that has ended', () => {
		const session = insertSession(db, { agentId, startedAt: 100 });
		endSession(db, session.id, 150);

		expect(heartbeatSession(db, session.id, 200)).toBe(false);
		expect(findSessionById(db, session.id)).toMatchObject({ lastHeartbeatAt: 100 });
	});

	it('reports false for an unknown session', () => {
		expect(heartbeatSession(db, 'nope', 1)).toBe(false);
	});
});

describe('endSession', () => {
	it('closes an open session once', () => {
		const session = insertSession(db, { agentId, startedAt: 100 });

		expect(endSession(db, session.id, 150)).toBe(true);
		expect(endSession(db, session.id, 900)).toBe(false);
		expect(findSessionById(db, session.id)).toMatchObject({ endedAt: 150 });
	});
});

describe('listLiveSessions', () => {
	it('is the presence query: open, and beating since the cutoff', () => {
		const fresh = insertSession(db, { agentId, startedAt: 1000 });
		const stale = insertSession(db, { agentId, startedAt: 100 });
		const closed = insertSession(db, { agentId, startedAt: 1000 });
		endSession(db, closed.id, 1001);

		const live = listLiveSessions(db, 900).map((s) => s.id);

		expect(live).toEqual([fresh.id]);
		expect(live).not.toContain(stale.id);
		expect(live).not.toContain(closed.id);
	});
});

describe('listSessionsForAgent', () => {
	it('lists newest first, optionally only the open ones', () => {
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;
		const first = insertSession(db, { agentId, startedAt: 1 });
		const second = insertSession(db, { agentId, startedAt: 2 });
		insertSession(db, { agentId: other, startedAt: 3 });
		endSession(db, first.id, 4);

		expect(listSessionsForAgent(db, agentId).map((s) => s.id)).toEqual([second.id, first.id]);
		expect(listSessionsForAgent(db, agentId, { openOnly: true }).map((s) => s.id)).toEqual([
			second.id
		]);
	});
});

describe('endStaleSessions', () => {
	it('closes sessions idle past the cutoff so an approval gate fails loudly', () => {
		const stale = insertSession(db, { agentId, startedAt: 100 });
		const live = insertSession(db, { agentId, startedAt: 1000 });

		const closed = endStaleSessions(db, { idleBefore: 900, at: 1200 });

		expect(closed).toEqual([stale.id]);
		expect(findSessionById(db, stale.id)).toMatchObject({ endedAt: 1200 });
		expect(findSessionById(db, live.id)).toMatchObject({ endedAt: null });
	});

	it('finds nothing to do twice in a row', () => {
		insertSession(db, { agentId, startedAt: 100 });
		endStaleSessions(db, { idleBefore: 900, at: 1200 });

		expect(endStaleSessions(db, { idleBefore: 900, at: 1300 })).toEqual([]);
	});
});
