import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import {
	findAgentById,
	findAgentByTokenHash,
	insertAgent,
	listAgents,
	revokeAgent,
	touchAgent
} from './agents';

let db: Db;
beforeEach(() => {
	db = freshDatabase();
});

describe('insertAgent', () => {
	it('stores a token hash and starts unrevoked and unseen', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });

		expect(agent).toMatchObject({
			name: 'claude',
			tokenHash: 'hash-1',
			revokedAt: null,
			lastSeenAt: null
		});
		expect(agent.id).toHaveLength(26);
	});

	it('refuses two agents with the same token hash', () => {
		insertAgent(db, { name: 'one', tokenHash: 'hash-1' });

		expect(() => insertAgent(db, { name: 'two', tokenHash: 'hash-1' })).toThrow(/UNIQUE/);
	});
});

describe('findAgentByTokenHash', () => {
	it('is how a bearer token is resolved to an agent', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });

		expect(findAgentByTokenHash(db, 'hash-1')).toEqual(agent);
		expect(findAgentByTokenHash(db, 'hash-2')).toBeUndefined();
	});

	it('still returns a revoked agent, so the caller can say why it was refused', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });
		revokeAgent(db, agent.id, 500);

		expect(findAgentByTokenHash(db, 'hash-1')).toMatchObject({ revokedAt: 500 });
	});
});

describe('revokeAgent', () => {
	it('stamps the revocation and reports whether it changed anything', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });

		expect(revokeAgent(db, agent.id, 500)).toBe(true);
		expect(findAgentById(db, agent.id)).toMatchObject({ revokedAt: 500 });
		// Already revoked: nothing to do, and the first revocation time stands.
		expect(revokeAgent(db, agent.id, 900)).toBe(false);
		expect(findAgentById(db, agent.id)).toMatchObject({ revokedAt: 500 });
	});

	it('reports false for an unknown agent', () => {
		expect(revokeAgent(db, 'nope', 1)).toBe(false);
	});
});

describe('touchAgent', () => {
	it('records the last time the agent was heard from', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });

		touchAgent(db, agent.id, 1234);

		expect(findAgentById(db, agent.id)).toMatchObject({ lastSeenAt: 1234 });
	});

	it('never moves last seen backwards, so an out-of-order call is harmless', () => {
		const agent = insertAgent(db, { name: 'claude', tokenHash: 'hash-1' });
		touchAgent(db, agent.id, 1234);

		touchAgent(db, agent.id, 1000);

		expect(findAgentById(db, agent.id)).toMatchObject({ lastSeenAt: 1234 });
	});
});

describe('listAgents', () => {
	it('lists oldest first, and hides revoked agents unless asked', () => {
		const one = insertAgent(db, { name: 'one', tokenHash: 'h1', createdAt: 1 });
		const two = insertAgent(db, { name: 'two', tokenHash: 'h2', createdAt: 2 });
		revokeAgent(db, two.id, 3);

		expect(listAgents(db).map((a) => a.id)).toEqual([one.id]);
		expect(listAgents(db, { includeRevoked: true }).map((a) => a.id)).toEqual([one.id, two.id]);
	});
});
