import type { AppEvent } from './types';

/**
 * The answer to "everything after seq N".
 *
 * A hit with no events (the caller is up to date) and a miss (the caller's cursor
 * has fallen out of the buffer) are different results on purpose: the SSE route
 * replays a hit and emits a single `resync` for a miss, and conflating the two
 * would silently hand the browser a partial gap it would render as truth
 * (design §4).
 */
export type ReplayResult =
	| { readonly hit: true; readonly events: readonly AppEvent[] }
	| { readonly hit: false; readonly reason: ReplayMiss };

/**
 * Why a replay could not be served.
 *
 * - `expired` — the cursor is older than the oldest buffered event.
 * - `ahead` — the cursor is newer than anything published, which is what a
 *   browser's `Last-Event-ID` looks like after the server restarted and the
 *   sequence began again.
 */
export type ReplayMiss = 'expired' | 'ahead';

/**
 * A fixed-size window over the most recent events.
 *
 * Deliberately in memory and deliberately lossy: the design trades a durable
 * event-log table for a buffer that covers a laptop sleeping, and makes the
 * uncovered case explicit by reporting a miss (design §4).
 */
export class EventRing {
	readonly capacity: number;

	/** Slots in insertion order once full, rotated around `#start`. */
	#slots: AppEvent[] = [];
	/** Index of the oldest event once the ring has wrapped. */
	#start = 0;

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`Event ring capacity must be a positive integer, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** How many events are currently retained. */
	get size(): number {
		return this.#slots.length;
	}

	/** The oldest retained seq, or `undefined` while nothing has been published. */
	get oldestSeq(): number | undefined {
		return this.#slots[this.#start]?.seq;
	}

	/** The most recently published seq, or `undefined` while nothing has been. */
	get newestSeq(): number | undefined {
		if (this.#slots.length === 0) return undefined;
		return this.#slots[(this.#start + this.#slots.length - 1) % this.#slots.length].seq;
	}

	/** Retain an event, evicting the oldest once the ring is full. */
	push(event: AppEvent): void {
		if (this.#slots.length < this.capacity) {
			this.#slots.push(event);
			return;
		}
		this.#slots[this.#start] = event;
		this.#start = (this.#start + 1) % this.capacity;
	}

	/** Everything retained, oldest first. */
	toArray(): AppEvent[] {
		const { length } = this.#slots;
		if (length === 0) return [];
		return [...this.#slots.slice(this.#start), ...this.#slots.slice(0, this.#start)];
	}

	/**
	 * Everything published after `seq`, or a miss when that cannot be answered
	 * completely.
	 *
	 * `seq` is what the caller has already seen, so `since(newestSeq)` is a hit
	 * with no events, and a fresh caller passes `0`.
	 */
	since(seq: number): ReplayResult {
		const newest = this.newestSeq ?? 0;
		// While the ring is empty nothing has ever been published, so the only
		// cursor it can serve is "I have seen nothing".
		const oldest = this.oldestSeq ?? newest + 1;

		if (seq > newest) return { hit: false, reason: 'ahead' };
		if (seq < oldest - 1) return { hit: false, reason: 'expired' };
		return { hit: true, events: this.toArray().filter((event) => event.seq > seq) };
	}
}
