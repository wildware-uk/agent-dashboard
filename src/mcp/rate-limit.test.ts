import { describe, expect, it } from 'vitest';
import {
	MCP_RATE_LIMIT,
	MCP_RATE_WINDOW_MS,
	createTokenRateLimiter,
	retryAfterSeconds
} from './rate-limit';

/** A limiter whose clock the test drives. */
function limiter(options: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
	let now = 1_000;
	const rate = createTokenRateLimiter({
		limit: options.limit ?? 3,
		windowMs: options.windowMs ?? 1_000,
		maxKeys: options.maxKeys,
		now: () => now
	});
	return {
		rate,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

describe('createTokenRateLimiter', () => {
	it('allows up to the limit inside the window, then refuses', () => {
		const { rate } = limiter({ limit: 3 });

		expect(rate.take('a')).toMatchObject({ allowed: true, remaining: 2 });
		expect(rate.take('a')).toMatchObject({ allowed: true, remaining: 1 });
		expect(rate.take('a')).toMatchObject({ allowed: true, remaining: 0 });
		expect(rate.take('a')).toMatchObject({ allowed: false });
	});

	it('says how long to wait, and lets the caller back in once the window slides', () => {
		const { rate, advance } = limiter({ limit: 2, windowMs: 1_000 });
		rate.take('a');
		rate.take('a');

		const refused = rate.take('a');
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) expect(refused.retryAfterMs).toBe(1_000);

		advance(999);
		expect(rate.take('a').allowed).toBe(false);
		advance(2);
		expect(rate.take('a').allowed).toBe(true);
	});

	it('counts each token separately: one chatty agent cannot throttle another', () => {
		const { rate } = limiter({ limit: 1 });

		expect(rate.take('a').allowed).toBe(true);
		expect(rate.take('a').allowed).toBe(false);
		expect(rate.take('b').allowed).toBe(true);
	});

	it('a refused call does not deepen the hole it is in', () => {
		const { rate, advance } = limiter({ limit: 1, windowMs: 1_000 });
		rate.take('a');

		advance(500);
		const first = rate.take('a');
		expect(first.allowed).toBe(false);
		if (!first.allowed) expect(first.retryAfterMs).toBe(500);

		// Spending a refusal must not extend the window, or a client that retries
		// hard would lock itself out for ever.
		advance(400);
		const second = rate.take('a');
		expect(second.allowed).toBe(false);
		if (!second.allowed) expect(second.retryAfterMs).toBe(100);

		advance(101);
		expect(rate.take('a').allowed).toBe(true);
	});

	it('forgets attempts once their window has passed, so the map cannot grow for ever', () => {
		const { rate, advance } = limiter({ limit: 2, windowMs: 1_000 });
		rate.take('a');
		rate.take('b');
		expect(rate.size()).toBe(2);

		advance(1_001);
		rate.take('c');
		expect(rate.size()).toBe(1);
	});

	it('evicts the least recently seen key when the cap is reached', () => {
		const { rate } = limiter({ limit: 1, maxKeys: 2 });

		rate.take('a');
		rate.take('b');
		rate.take('c');

		expect(rate.size()).toBe(2);
		// 'a' was pushed out, so it starts clean; 'c' is still limited.
		expect(rate.take('a').allowed).toBe(true);
		expect(rate.take('c').allowed).toBe(false);
	});

	it('ships defaults generous enough for a chatty agent but bounded', () => {
		expect(MCP_RATE_LIMIT).toBeGreaterThanOrEqual(60);
		expect(MCP_RATE_WINDOW_MS).toBe(60_000);
	});
});

describe('retryAfterSeconds', () => {
	it('rounds up to whole seconds, and never advises zero', () => {
		expect(retryAfterSeconds(1)).toBe(1);
		expect(retryAfterSeconds(1_000)).toBe(1);
		expect(retryAfterSeconds(1_001)).toBe(2);
		expect(retryAfterSeconds(0)).toBe(1);
	});
});
