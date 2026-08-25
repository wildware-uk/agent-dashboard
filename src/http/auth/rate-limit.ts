/**
 * A sliding-window rate limiter, in memory (design §8).
 *
 * In memory is the right scope: one process, one owner, and a counter that may
 * safely be forgotten on restart — a restart costs an attacker nothing they did
 * not already have, and buys the owner a way out if they lock themselves out.
 *
 * Pure and clock-injectable, so the window is tested by moving time rather than
 * by sleeping. `check` is deliberately separate from `record`: the login route
 * only spends an attempt on a real guess, not on a blank form or a request it
 * refused for other reasons.
 */
export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

export type RateLimiter = {
	/** Whether this key may attempt now. Records nothing. */
	check(key: string): RateLimitVerdict;
	/** Spend one attempt for this key. */
	record(key: string): void;
	/** Forget a key's attempts — what a successful login does. */
	reset(key: string): void;
	/** How many keys are being tracked. For tests and diagnostics. */
	size(): number;
};

export type RateLimiterOptions = {
	/** Attempts allowed inside the window. */
	limit: number;
	/** Length of the window, in milliseconds. */
	windowMs: number;
	/** Injectable clock. */
	now?: () => number;
	/**
	 * Cap on tracked keys. Keys are client addresses, which an attacker behind a
	 * botnet or a v6 prefix controls, so the map must not grow without bound.
	 * Eviction drops the least recently seen, never the caller being limited.
	 */
	maxKeys?: number;
};

const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter({
	limit,
	windowMs,
	now = Date.now,
	maxKeys = DEFAULT_MAX_KEYS
}: RateLimiterOptions): RateLimiter {
	// Insertion order is recency order: `record` re-inserts, so the first entry is
	// always the least recently seen and eviction is a `Map` walk from the front.
	const attempts = new Map<string, number[]>();

	function within(key: string): number[] {
		const cutoff = now() - windowMs;
		const kept = (attempts.get(key) ?? []).filter((at) => at > cutoff);
		return kept;
	}

	return {
		check(key) {
			const recent = within(key);
			if (recent.length < limit) return { allowed: true };
			// The window frees up as soon as the oldest attempt in it ages out.
			const retryAfterMs = recent[0] + windowMs - now();
			return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
		},

		record(key) {
			const recent = within(key);
			recent.push(now());
			attempts.delete(key);
			attempts.set(key, recent);

			for (const stale of attempts.keys()) {
				if (attempts.size <= maxKeys) break;
				attempts.delete(stale);
			}
		},

		reset(key) {
			attempts.delete(key);
		},

		size() {
			return attempts.size;
		}
	};
}
