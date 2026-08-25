import { beforeEach, describe, expect, it } from 'vitest';
import { findAgentById } from '$db';
import { mintAgentToken } from '$domain';
import { FIXED_NOW, harness, type Harness } from '$domain/testing';
import { authenticateMcpRequest, readBearerToken } from './auth';
import { createTokenRateLimiter } from './rate-limit';

const SECRET = 't'.repeat(32);

let h: Harness;
beforeEach(() => {
	h = harness();
});

function attempt(
	authorization: string | undefined,
	options: { rateLimiter?: ReturnType<typeof createTokenRateLimiter> } = {}
) {
	const headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return authenticateMcpRequest({
		request: new Request('http://dash.test/mcp', { method: 'POST', headers }),
		ctx: h,
		secret: SECRET,
		rateLimiter: options.rateLimiter ?? createTokenRateLimiter()
	});
}

describe('readBearerToken', () => {
	it('reads the token out of a bearer header, whatever the case of the scheme', () => {
		expect(readBearerToken('Bearer abc')).toEqual({ ok: true, token: 'abc' });
		expect(readBearerToken('bearer abc')).toEqual({ ok: true, token: 'abc' });
		expect(readBearerToken('BEARER   abc  ')).toEqual({ ok: true, token: 'abc' });
	});

	it('reports a missing header and an empty one the same way', () => {
		for (const header of [undefined, null, '', '   ']) {
			expect(readBearerToken(header)).toMatchObject({ ok: false, error: 'missing_token' });
		}
	});

	it('names the scheme problem rather than pretending the token is bad', () => {
		expect(readBearerToken('Basic abc')).toMatchObject({ ok: false, error: 'unsupported_scheme' });
		expect(readBearerToken('abc')).toMatchObject({ ok: false, error: 'unsupported_scheme' });
		expect(readBearerToken('Bearer')).toMatchObject({ ok: false, error: 'missing_token' });
		expect(readBearerToken('Bearer  ')).toMatchObject({ ok: false, error: 'missing_token' });
	});
});

describe('authenticateMcpRequest', () => {
	it('resolves the agent that owns the token and stamps it as seen', () => {
		const { agent, token } = mintAgentToken(h, { name: 'scout', secret: SECRET });
		expect(agent.lastSeenAt).toBeNull();

		const outcome = attempt(`Bearer ${token}`);

		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.agent.id).toBe(agent.id);
			// The key the limiter counts on is the HMAC, never the token itself.
			expect(outcome.tokenHash).toBe(agent.tokenHash);
			expect(outcome.tokenHash).not.toContain(token);
		}
		expect(findAgentById(h.db, agent.id)?.lastSeenAt).toBe(FIXED_NOW);
	});

	it('refuses a request with no credentials at all with 401', () => {
		const outcome = attempt(undefined);

		expect(outcome).toMatchObject({ ok: false, status: 401, error: 'missing_token' });
	});

	it('refuses a malformed token with 401 and says it is malformed', () => {
		expect(attempt('Bearer not-a-token')).toMatchObject({
			ok: false,
			status: 401,
			error: 'malformed_token'
		});
	});

	it('refuses an unknown token with 401', () => {
		expect(attempt(`Bearer ${'A'.repeat(43)}`)).toMatchObject({
			ok: false,
			status: 401,
			error: 'unknown_token'
		});
	});

	it('refuses a revoked token with 401 and says so, not "unknown"', () => {
		const { agent, token } = mintAgentToken(h, { name: 'scout', secret: SECRET });
		h.db.prepare('UPDATE agents SET revoked_at = 1 WHERE id = ?').run(agent.id);

		expect(attempt(`Bearer ${token}`)).toMatchObject({
			ok: false,
			status: 401,
			error: 'revoked_token'
		});
	});

	it('rate limits per token, and tells the caller when to come back', () => {
		const rateLimiter = createTokenRateLimiter({ limit: 2, windowMs: 5_000 });
		const first = mintAgentToken(h, { name: 'chatty', secret: SECRET });
		const second = mintAgentToken(h, { name: 'quiet', secret: SECRET });

		expect(attempt(`Bearer ${first.token}`, { rateLimiter }).ok).toBe(true);
		expect(attempt(`Bearer ${first.token}`, { rateLimiter }).ok).toBe(true);

		const refused = attempt(`Bearer ${first.token}`, { rateLimiter });
		expect(refused).toMatchObject({ ok: false, status: 429, error: 'rate_limited' });
		if (!refused.ok && refused.status === 429) expect(refused.retryAfterMs).toBeGreaterThan(0);

		// The other agent's budget is its own.
		expect(attempt(`Bearer ${second.token}`, { rateLimiter }).ok).toBe(true);
	});

	it('rate limits an unknown token too, so a bad client cannot loop for free', () => {
		const rateLimiter = createTokenRateLimiter({ limit: 1, windowMs: 5_000 });
		const bogus = `Bearer ${'B'.repeat(43)}`;

		expect(attempt(bogus, { rateLimiter })).toMatchObject({ error: 'unknown_token' });
		expect(attempt(bogus, { rateLimiter })).toMatchObject({ status: 429 });
	});

	it('spends no rate-limit budget on a request that carries no usable token', () => {
		const rateLimiter = createTokenRateLimiter({ limit: 1, windowMs: 5_000 });

		attempt(undefined, { rateLimiter });
		attempt('Basic zzz', { rateLimiter });
		attempt('Bearer nope', { rateLimiter });

		expect(rateLimiter.size()).toBe(0);
	});
});
