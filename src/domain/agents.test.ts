import { beforeEach, describe, expect, it } from 'vitest';
import { findAgentById, findAgentByTokenHash, insertAgent } from '$db';
import {
	AGENT_NAME_MAX_LENGTH,
	TOKEN_LENGTH,
	authenticateAgent,
	constantTimeEquals,
	hashAgentToken,
	isTokenShaped,
	listAgents,
	mintAgentToken,
	noteAgentSeen,
	revokeAgentToken
} from './agents';
import { DomainError } from './errors';
import { FIXED_NOW, harness, type Harness } from './testing';

const SECRET = 't'.repeat(32);
const OTHER_SECRET = 'u'.repeat(32);

let h: Harness;
beforeEach(() => {
	h = harness();
});

describe('hashAgentToken', () => {
	it('is a hex HMAC-SHA256, so it is fixed width whatever the token', () => {
		const short = hashAgentToken('a', SECRET);
		const long = hashAgentToken('a'.repeat(1000), SECRET);

		expect(short).toMatch(/^[0-9a-f]{64}$/);
		expect(long).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic under one secret and different under another', () => {
		expect(hashAgentToken('token', SECRET)).toBe(hashAgentToken('token', SECRET));
		expect(hashAgentToken('token', SECRET)).not.toBe(hashAgentToken('token', OTHER_SECRET));
	});

	it('refuses to hash under an empty secret rather than key the HMAC with nothing', () => {
		expect(() => hashAgentToken('token', '')).toThrow(DomainError);
	});
});

describe('mintAgentToken', () => {
	it('returns a token of the documented shape and stores only its hash', () => {
		const { agent, token } = mintAgentToken(h, { name: 'claude-code', secret: SECRET });

		expect(token).toHaveLength(TOKEN_LENGTH);
		expect(isTokenShaped(token)).toBe(true);
		expect(agent).toMatchObject({
			name: 'claude-code',
			createdAt: FIXED_NOW,
			revokedAt: null,
			lastSeenAt: null
		});
		// The row must never carry the token itself (design §8).
		expect(agent.tokenHash).toBe(hashAgentToken(token, SECRET));
		expect(agent.tokenHash).not.toContain(token);
		expect(findAgentByTokenHash(h.db, agent.tokenHash)?.id).toBe(agent.id);
	});

	it('mints a distinct token every time', () => {
		const tokens = new Set(
			Array.from({ length: 20 }, () => mintAgentToken(h, { name: 'a', secret: SECRET }).token)
		);

		expect(tokens.size).toBe(20);
	});

	it('trims the name and requires one', () => {
		expect(mintAgentToken(h, { name: '  scout  ', secret: SECRET }).agent.name).toBe('scout');
		expect(() => mintAgentToken(h, { name: '   ', secret: SECRET })).toThrow(DomainError);
		expect(() =>
			mintAgentToken(h, { name: 'x'.repeat(AGENT_NAME_MAX_LENGTH + 1), secret: SECRET })
		).toThrow(/at most/);
	});

	it('publishes nothing: the event vocabulary has no agent lifecycle event (§4)', () => {
		mintAgentToken(h, { name: 'scout', secret: SECRET });

		expect(h.eventNames()).toEqual([]);
	});
});

describe('authenticateAgent', () => {
	it('resolves the agent that owns the token', () => {
		const { agent, token } = mintAgentToken(h, { name: 'scout', secret: SECRET });

		const result = authenticateAgent(h, { token, secret: SECRET });

		expect(result).toEqual({ ok: true, agent });
	});

	it('reports a missing token', () => {
		for (const token of [undefined, null, '', '   ']) {
			const result = authenticateAgent(h, { token, secret: SECRET });
			expect(result).toMatchObject({ ok: false, reason: 'missing_token' });
		}
	});

	it('reports a malformed token without looking it up', () => {
		const result = authenticateAgent(h, { token: 'not-a-real-token', secret: SECRET });

		expect(result).toMatchObject({ ok: false, reason: 'malformed_token' });
		expect(result.ok).toBe(false);
	});

	it('reports an unknown token, and a right-shaped token under the wrong secret is unknown', () => {
		const { token } = mintAgentToken(h, { name: 'scout', secret: SECRET });

		expect(authenticateAgent(h, { token, secret: OTHER_SECRET })).toMatchObject({
			ok: false,
			reason: 'unknown_token'
		});
		expect(authenticateAgent(h, { token: 'A'.repeat(TOKEN_LENGTH), secret: SECRET })).toMatchObject(
			{ ok: false, reason: 'unknown_token' }
		);
	});

	it('reports a revoked token separately, so the owner can tell it apart', () => {
		const { agent, token } = mintAgentToken(h, { name: 'scout', secret: SECRET });
		revokeAgentToken(h, agent.id);

		expect(authenticateAgent(h, { token, secret: SECRET })).toMatchObject({
			ok: false,
			reason: 'revoked_token'
		});
	});

	it('carries a message an adapter can hand straight to the caller', () => {
		const result = authenticateAgent(h, { token: 'nope', secret: SECRET });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/token/i);
	});

	it('rejects a stored hash that is not the one the token produces', () => {
		// A row planted with someone else's hash must not authenticate a token just
		// because the lookup was asked the wrong question.
		const planted = insertAgent(h.db, { name: 'imposter', tokenHash: 'deadbeef' });
		expect(authenticateAgent(h, { token: 'deadbeef', secret: SECRET })).toMatchObject({
			ok: false,
			reason: 'malformed_token'
		});
		expect(findAgentById(h.db, planted.id)?.name).toBe('imposter');
	});
});

describe('constantTimeEquals', () => {
	it('compares equal strings as equal', () => {
		expect(constantTimeEquals('abc', 'abc')).toBe(true);
	});

	it('rejects different strings, including ones of different length', () => {
		expect(constantTimeEquals('abc', 'abd')).toBe(false);
		expect(constantTimeEquals('abc', 'abcd')).toBe(false);
		expect(constantTimeEquals('', 'a')).toBe(false);
	});
});

describe('noteAgentSeen', () => {
	it('records the call and never moves the timestamp backwards', () => {
		const { agent } = mintAgentToken(h, { name: 'scout', secret: SECRET });

		noteAgentSeen(h, agent.id);
		expect(findAgentById(h.db, agent.id)?.lastSeenAt).toBe(FIXED_NOW);

		const earlier = harness({ db: h.db, now: () => FIXED_NOW - 60_000 });
		noteAgentSeen(earlier, agent.id);
		expect(findAgentById(h.db, agent.id)?.lastSeenAt).toBe(FIXED_NOW);
	});

	it('is quiet about an agent that is not there: presence is not a rule', () => {
		expect(() => noteAgentSeen(h, 'nobody')).not.toThrow();
	});
});

describe('revokeAgentToken', () => {
	it('revokes once, reports the repeat, and refuses an unknown agent', () => {
		const { agent } = mintAgentToken(h, { name: 'scout', secret: SECRET });

		expect(revokeAgentToken(h, agent.id)).toBe(true);
		expect(findAgentById(h.db, agent.id)?.revokedAt).toBe(FIXED_NOW);
		expect(revokeAgentToken(h, agent.id)).toBe(false);
		expect(() => revokeAgentToken(h, 'nobody')).toThrow(DomainError);
	});
});

describe('listAgents', () => {
	it('hides revoked agents unless they are asked for', () => {
		const live = mintAgentToken(h, { name: 'live', secret: SECRET }).agent;
		const dead = mintAgentToken(h, { name: 'dead', secret: SECRET }).agent;
		revokeAgentToken(h, dead.id);

		expect(listAgents(h).map((agent) => agent.id)).toEqual([live.id]);
		expect(listAgents(h, { includeRevoked: true }).map((agent) => agent.id)).toEqual([
			live.id,
			dead.id
		]);
	});
});
