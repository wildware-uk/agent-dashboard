/**
 * Per-token rate limiting for `/mcp` (design §8).
 *
 * Sliding window, in memory, keyed by the **HMAC of the bearer token** — never
 * the token itself, so a heap dump of a running process yields nothing usable,
 * and never the agent id, so a request carrying an unknown token is limited too.
 * That is the case worth limiting: a client looping on a bad token, or someone
 * guessing, must not get unlimited HMAC-and-lookup work out of the server.
 *
 * `take()` is deliberately one call rather than the check/record pair
 * `src/http/auth/rate-limit.ts` exposes: every MCP request costs exactly one
 * unit, so there is no "attempt we decided not to spend". This module is a
 * separate implementation because `$mcp` may not import `$http` (design §2), and
 * a shared limiter would have to live in the domain, which is not a business
 * rule. Twenty lines of duplication is the cheaper of the two prices.
 */

/** Requests one token may make per window. */
export const MCP_RATE_LIMIT = 120;

/** The window, in milliseconds. */
export const MCP_RATE_WINDOW_MS = 60_000;

/**
 * Cap on tracked keys.
 *
 * Keys are token hashes, and an attacker chooses how many distinct tokens it
 * sends, so the map has to be bounded. Eviction drops the least recently seen.
 */
const DEFAULT_MAX_KEYS = 10_000;

export type RateVerdict =
	{ allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };

export type TokenRateLimiter = {
	/** Spend one request for this key and say whether it was allowed. */
	take(key: string): RateVerdict;
	/** Forget a key. */
	reset(key: string): void;
	/** How many keys are tracked. For tests and diagnostics. */
	size(): number;
};

export type TokenRateLimiterOptions = {
	limit?: number;
	windowMs?: number;
	now?: () => number;
	maxKeys?: number;
};

export function createTokenRateLimiter({
	limit = MCP_RATE_LIMIT,
	windowMs = MCP_RATE_WINDOW_MS,
	now = Date.now,
	maxKeys = DEFAULT_MAX_KEYS
}: TokenRateLimiterOptions = {}): TokenRateLimiter {
	// Insertion order is recency order: every `take` re-inserts, so the first
	// entry is always the least recently seen and eviction walks from the front.
	const hits = new Map<string, number[]>();

	/**
	 * Drop keys whose whole window has aged out.
	 *
	 * Insertion order is recency order, so the front of the map is the oldest
	 * touched key: the walk stops at the first key that is still inside its
	 * window and costs nothing on a busy server. Without this the map would only
	 * shrink at {@link DEFAULT_MAX_KEYS}, so a burst of one-shot bad tokens would
	 * be held in memory long after every one of them had expired.
	 */
	function sweep(cutoff: number): void {
		for (const [key, seen] of hits) {
			if ((seen.at(-1) ?? 0) > cutoff) break;
			hits.delete(key);
		}
	}

	return {
		take(key) {
			const at = now();
			const cutoff = at - windowMs;
			sweep(cutoff);
			const recent = (hits.get(key) ?? []).filter((seen) => seen > cutoff);

			if (recent.length >= limit) {
				// The window frees up when its oldest hit ages out. A refused call is
				// not recorded: a client retrying hard would otherwise hold its own
				// window open for ever.
				hits.delete(key);
				hits.set(key, recent);
				return { allowed: false, retryAfterMs: Math.max(recent[0] + windowMs - at, 0) };
			}

			recent.push(at);
			hits.delete(key);
			hits.set(key, recent);

			for (const stale of hits.keys()) {
				if (hits.size <= maxKeys) break;
				hits.delete(stale);
			}

			return { allowed: true, remaining: limit - recent.length };
		},

		reset(key) {
			hits.delete(key);
		},

		size() {
			return hits.size;
		}
	};
}

/** `Retry-After` is whole seconds, and advising `0` invites an instant retry. */
export function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
