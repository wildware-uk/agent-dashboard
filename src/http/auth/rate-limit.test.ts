import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

/** A clock the test moves by hand: no fake timers, no sleeping. */
function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('the login rate limiter', () => {
	it('allows attempts up to the limit', () => {
		const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

		for (let i = 0; i < 3; i++) {
			expect(limiter.check('1.2.3.4').allowed, `attempt ${i + 1}`).toBe(true);
			limiter.record('1.2.3.4');
		}

		expect(limiter.check('1.2.3.4').allowed).toBe(false);
	});

	it('says how long to wait', () => {
		const time = clock();
		const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: time.now });
		limiter.record('1.2.3.4');
		time.advance(20_000);

		const verdict = limiter.check('1.2.3.4');

		expect(verdict).toEqual({ allowed: false, retryAfterMs: 40_000 });
	});

	it('forgets attempts once their window has passed', () => {
		const time = clock();
		const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: time.now });
		limiter.record('1.2.3.4');
		limiter.record('1.2.3.4');
		expect(limiter.check('1.2.3.4').allowed).toBe(false);

		time.advance(60_001);

		expect(limiter.check('1.2.3.4').allowed).toBe(true);
	});

	it('limits each client separately, so one attacker cannot lock the owner out', () => {
		const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

		limiter.record('1.2.3.4');

		expect(limiter.check('1.2.3.4').allowed).toBe(false);
		expect(limiter.check('5.6.7.8').allowed).toBe(true);
	});

	it('clears a client on success, so a typo does not count against the next login', () => {
		const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
		limiter.record('1.2.3.4');

		limiter.reset('1.2.3.4');

		expect(limiter.check('1.2.3.4').allowed).toBe(true);
	});

	it('does not grow without bound when the keys are attacker-controlled', () => {
		const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });

		for (let i = 0; i < 50; i++) limiter.record(`10.0.0.${i}`);

		expect(limiter.size()).toBeLessThanOrEqual(10);
		// Evicting must not hand the current attacker a fresh allowance.
		expect(limiter.check('10.0.0.49').allowed).toBe(false);
	});
});
