import { EventRing, type ReplayResult } from './ring';
import type { AppEvent, EventName, EventOf, EventPayloads } from './types';

/**
 * How many events stay replayable (design §4).
 *
 * Enough to cover a browser reconnecting after a sleep on a busy deployment;
 * anything older is answered with a miss and a snapshot refetch.
 */
export const RING_CAPACITY = 500;

/** Called with an event; returns nothing. Fan-out never awaits a subscriber. */
export type EventListener = (event: AppEvent) => void;

/** Drops a subscription. Idempotent, so a caller may call it on every teardown path. */
export type Unsubscribe = () => void;

/** What to do with a subscriber that throws, so one bad listener cannot break fan-out. */
export type ListenerErrorHandler = (error: unknown, event: AppEvent) => void;

export interface EventBusOptions {
	/** Replay window size. Defaults to {@link RING_CAPACITY}. */
	capacity?: number;
	/** Defaults to logging, because a thrown subscriber is a bug worth seeing. */
	onListenerError?: ListenerErrorHandler;
}

/** What a parked caller is waiting for. */
export interface WaitOptions<K extends EventName> {
	/** Give up after this many milliseconds and resolve `undefined`. */
	timeoutMs: number;
	/** Event types to watch. Omit to watch every type. */
	types?: readonly K[];
	/** Extra condition, e.g. "this approval id". */
	where?: (event: EventOf<K>) => boolean;
	/**
	 * A seq the caller has already accounted for. The replay buffer is scanned for
	 * a match published after it before parking, which closes the race between
	 * writing a row and waiting on the event announcing its decision.
	 *
	 * If the buffer no longer reaches that far back the wait simply parks: the
	 * caller's durable state, not this buffer, is the authority (design §5).
	 */
	since?: number;
	/** Abort the wait early, e.g. when the requesting connection goes away. */
	signal?: AbortSignal;
}

/**
 * Typed in-process publish/subscribe with a replay window.
 *
 * The single fan-out point (design §2): the domain publishes, the SSE route
 * subscribes, and parked approval gates wait on a predicate. It knows nothing
 * about HTTP or MCP, and holds no state that matters beyond the process.
 */
export class EventBus {
	#seq = 0;
	readonly #ring: EventRing;
	readonly #listeners = new Set<EventListener>();
	readonly #onListenerError: ListenerErrorHandler;

	constructor(options: EventBusOptions = {}) {
		this.#ring = new EventRing(options.capacity ?? RING_CAPACITY);
		this.#onListenerError =
			options.onListenerError ??
			((error, event) => console.error(`event subscriber threw on ${event.type}`, error));
	}

	/** Live subscriber count, including parked waiters. Exists to prove no leaks. */
	get listenerCount(): number {
		return this.#listeners.size;
	}

	/** The last seq handed out, i.e. the newest event any subscriber has seen. */
	get lastSeq(): number {
		return this.#seq;
	}

	/**
	 * Stamp an event with the next sequence number, retain it for replay, and hand
	 * it to every subscriber synchronously.
	 *
	 * @returns the stamped event, so a caller can quote its `seq` as a cursor.
	 */
	publish<K extends EventName>(type: K, payload: EventPayloads[K]): EventOf<K> {
		this.#seq += 1;
		// The cast is the one place types are asserted rather than checked: `type`
		// and `payload` were checked against each other by the signature, but the
		// compiler cannot see that a generic `K` picks one member of the union.
		const event = {
			type,
			seq: this.#seq,
			at: new Date().toISOString(),
			payload
		} as AppEvent;

		this.#ring.push(event);
		// Iterate a copy: a subscriber is allowed to unsubscribe, or subscribe,
		// from inside its own callback without disturbing this dispatch.
		for (const listener of [...this.#listeners]) {
			if (!this.#listeners.has(listener)) continue;
			try {
				listener(event);
			} catch (error) {
				this.#onListenerError(error, event);
			}
		}
		return event as EventOf<K>;
	}

	/**
	 * Receive every event published from now on.
	 *
	 * @returns a function that removes the listener. Calling it more than once is
	 *   harmless, so teardown paths never need to guard.
	 */
	subscribe(listener: EventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Everything published after `seq`, or a miss when the buffer cannot answer in
	 * full. See {@link ReplayResult}: a miss is not an empty gap.
	 */
	replaySince(seq: number): ReplayResult {
		return this.#ring.since(seq);
	}

	/**
	 * Park until a matching event arrives, the timeout elapses, or the caller
	 * aborts.
	 *
	 * This is what the approval gate holds on (design §5): a bounded wait that
	 * always resolves and always unsubscribes, so a client that walks away leaves
	 * nothing behind.
	 *
	 * @returns the matching event, or `undefined` if the wait ended without one.
	 */
	waitFor<K extends EventName = EventName>(
		options: WaitOptions<K>
	): Promise<EventOf<K> | undefined> {
		const { timeoutMs, types, where, since, signal } = options;
		const matches = (event: AppEvent): boolean => {
			if (types && !(types as readonly EventName[]).includes(event.type)) return false;
			return where ? where(event as EventOf<K>) : true;
		};

		if (signal?.aborted) return Promise.resolve(undefined);

		if (since !== undefined) {
			const replay = this.replaySince(since);
			if (replay.hit) {
				const already = replay.events.find(matches);
				if (already) return Promise.resolve(already as EventOf<K>);
			}
		}

		return new Promise<EventOf<K> | undefined>((resolve) => {
			// `settle` is the only exit: whichever of the three paths gets there
			// first tears down the other two.
			const settle = (event: EventOf<K> | undefined) => {
				unsubscribe();
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				resolve(event);
			};
			const onAbort = () => settle(undefined);
			const timer = setTimeout(() => settle(undefined), timeoutMs);
			const unsubscribe = this.subscribe((event) => {
				if (matches(event)) settle(event as EventOf<K>);
			});

			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}
}

/**
 * The bus for this process.
 *
 * Every module shares this instance — a second one would silently split the
 * fan-out. Tests construct their own `EventBus` instead of reaching for this.
 */
export const bus = new EventBus();
