import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, RING_CAPACITY, bus as sharedBus } from './bus';
import type { AppEvent } from './types';

describe('EventBus publish', () => {
	it('stamps a monotonic sequence starting at one', () => {
		const bus = new EventBus();

		expect(bus.publish('project.created', { projectId: 'p1', slug: 'one' }).seq).toBe(1);
		expect(bus.publish('project.updated', { projectId: 'p1', slug: 'one' }).seq).toBe(2);
		expect(bus.publish('update.deleted', { updateId: 'u1', projectId: 'p1' }).seq).toBe(3);
	});

	it('returns the stamped event so the caller can quote the seq', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-25T09:30:00.000Z'));
		const bus = new EventBus();

		try {
			expect(bus.publish('media.ready', { mediaId: 'm1', updateId: 'u1', kind: 'image' })).toEqual({
				type: 'media.ready',
				seq: 1,
				at: '2026-08-25T09:30:00.000Z',
				payload: { mediaId: 'm1', updateId: 'u1', kind: 'image' }
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects malformed publishes at compile time, proven by `npm run typecheck`', () => {
		const bus = new EventBus();

		// Never called: the assertions here are the compiler's. Each line must be a
		// type error, or `npm run typecheck` fails on the unused @ts-expect-error.
		const wrong = () => {
			// @ts-expect-error unknown event type
			bus.publish('project.exploded', { projectId: 'p1', slug: 'one' });
			// @ts-expect-error payload is missing `slug`
			bus.publish('project.created', { projectId: 'p1' });
			// @ts-expect-error `title` is not part of this payload
			bus.publish('update.created', { updateId: 'u', projectId: 'p', agentId: 'a', title: 'x' });
			// @ts-expect-error `online` is a boolean
			bus.publish('agent.presence', { agentId: 'a', sessionId: null, online: 'yes' });
			// @ts-expect-error a payload is required
			bus.publish('task.created');
		};

		expect(wrong).toBeTypeOf('function');
	});
});

describe('EventBus subscribe', () => {
	it('delivers every event to every subscriber', () => {
		const bus = new EventBus();
		const first: AppEvent[] = [];
		const second: AppEvent[] = [];
		bus.subscribe((event) => first.push(event));
		bus.subscribe((event) => second.push(event));

		bus.publish('task.created', { taskId: 't1', projectId: 'p1', agentId: null, state: 'todo' });

		expect(first.map((e) => e.type)).toEqual(['task.created']);
		expect(second).toEqual(first);
	});

	it('removes the listener when the returned function is called', () => {
		const bus = new EventBus();
		const seen: AppEvent[] = [];
		const unsubscribe = bus.subscribe((event) => seen.push(event));

		bus.publish('message.created', { messageId: 'm1', projectId: 'p1', author: 'human' });
		unsubscribe();
		bus.publish('message.created', { messageId: 'm2', projectId: 'p1', author: 'human' });

		expect(seen.map((e) => e.payload)).toEqual([
			{ messageId: 'm1', projectId: 'p1', author: 'human' }
		]);
		expect(bus.listenerCount).toBe(0);
	});

	it('leaks nothing when many subscribers come and go', () => {
		const bus = new EventBus();
		const unsubscribes = Array.from({ length: 50 }, () => bus.subscribe(() => {}));

		expect(bus.listenerCount).toBe(50);
		for (const unsubscribe of unsubscribes) unsubscribe();

		expect(bus.listenerCount).toBe(0);
	});

	it('tolerates unsubscribing twice', () => {
		const bus = new EventBus();
		const unsubscribe = bus.subscribe(() => {});

		unsubscribe();
		unsubscribe();

		expect(bus.listenerCount).toBe(0);
	});

	it('still reaches the other subscribers when one unsubscribes mid-dispatch', () => {
		const bus = new EventBus();
		const seen: string[] = [];
		const unsubscribeSelf = bus.subscribe(() => {
			seen.push('first');
			unsubscribeSelf();
		});
		bus.subscribe(() => seen.push('second'));

		bus.publish('agent.presence', { agentId: 'a1', sessionId: 's1', online: true });

		expect(seen).toEqual(['first', 'second']);
		expect(bus.listenerCount).toBe(1);
	});

	it('reports a throwing subscriber instead of dropping the fan-out', () => {
		const onListenerError = vi.fn();
		const bus = new EventBus({ onListenerError });
		const boom = new Error('subscriber blew up');
		bus.subscribe(() => {
			throw boom;
		});
		const seen: AppEvent[] = [];
		bus.subscribe((event) => seen.push(event));

		const published = bus.publish('request.created', {
			requestId: 'a1',
			agentId: 'ag1',
			projectId: 'p1',
			kind: 'confirm'
		});

		expect(seen).toEqual([published]);
		expect(onListenerError).toHaveBeenCalledWith(boom, published);
	});
});

describe('EventBus replay', () => {
	function publishMany(bus: EventBus, count: number) {
		for (let n = 1; n <= count; n += 1) {
			bus.publish('update.created', { updateId: `u${n}`, projectId: 'p1', agentId: 'ag1' });
		}
	}

	it('keeps the last 500 events by default', () => {
		expect(RING_CAPACITY).toBe(500);
		const bus = new EventBus();
		publishMany(bus, 600);

		// 600 published, 500 retained: seqs 101..600, so a cursor at 100 is the
		// oldest one still servable and 99 has fallen off.
		const oldestServable = bus.replaySince(100);

		expect(oldestServable.hit && oldestServable.events).toHaveLength(500);
		expect(bus.replaySince(99)).toEqual({ hit: false, reason: 'expired' });
		expect(bus.lastSeq).toBe(600);
	});

	it('replays exactly the events after a buffered seq', () => {
		const bus = new EventBus();
		publishMany(bus, 600);

		const result = bus.replaySince(597);

		expect(result.hit && result.events.map((e) => e.seq)).toEqual([598, 599, 600]);
	});

	it('reports a miss for a seq older than the buffer', () => {
		const bus = new EventBus();
		publishMany(bus, 600);

		expect(bus.replaySince(99)).toEqual({ hit: false, reason: 'expired' });
	});

	it('hands a fresh browser an empty gap rather than a miss', () => {
		expect(new EventBus().replaySince(0)).toEqual({ hit: true, events: [] });
	});
});

describe('EventBus waitFor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const settled = {
		requestId: 'a1',
		agentId: 'ag1',
		state: 'answered',
		settledAt: '2026-08-25T09:30:00.000Z'
	} as const;

	it('resolves with the first matching event', async () => {
		const bus = new EventBus();
		const parked = bus.waitFor({ types: ['request.answered'], timeoutMs: 55_000 });

		const published = bus.publish('request.answered', settled);

		await expect(parked).resolves.toEqual(published);
	});

	it('ignores events of another type and a non-matching predicate', async () => {
		const bus = new EventBus();
		const parked = bus.waitFor({
			types: ['request.answered'],
			where: (event) => event.payload.requestId === 'a2',
			timeoutMs: 55_000
		});

		bus.publish('request.created', {
			requestId: 'a2',
			agentId: 'ag1',
			projectId: null,
			kind: 'confirm'
		});
		bus.publish('request.answered', settled);
		const other = bus.publish('request.answered', { ...settled, requestId: 'a2' });

		await expect(parked).resolves.toEqual(other);
	});

	it('resolves undefined when the hold elapses, and unparks itself', async () => {
		const bus = new EventBus();
		const parked = bus.waitFor({ types: ['request.answered'], timeoutMs: 55_000 });

		expect(bus.listenerCount).toBe(1);
		await vi.advanceTimersByTimeAsync(54_999);
		expect(bus.listenerCount).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(parked).resolves.toBeUndefined();
		expect(bus.listenerCount).toBe(0);
	});

	it('clears its timer once a match arrives, leaving nothing pending', async () => {
		const bus = new EventBus();
		const parked = bus.waitFor({ types: ['request.answered'], timeoutMs: 55_000 });

		bus.publish('request.answered', settled);
		await parked;

		expect(bus.listenerCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('catches a match that was published before the caller parked', async () => {
		const bus = new EventBus();
		const created = bus.publish('request.created', {
			requestId: 'a1',
			agentId: 'ag1',
			projectId: null,
			kind: 'confirm'
		});
		// The human answered in the window between the DB write and the park.
		const published = bus.publish('request.answered', settled);

		const parked = bus.waitFor({
			types: ['request.answered'],
			since: created.seq,
			timeoutMs: 55_000
		});

		await expect(parked).resolves.toEqual(published);
		expect(bus.listenerCount).toBe(0);
	});

	it('does not re-deliver a match at or before the `since` seq', async () => {
		const bus = new EventBus();
		const stale = bus.publish('request.answered', settled);

		const parked = bus.waitFor({
			types: ['request.answered'],
			since: stale.seq,
			timeoutMs: 55_000
		});
		await vi.advanceTimersByTimeAsync(55_000);

		await expect(parked).resolves.toBeUndefined();
	});

	it('parks normally when `since` is older than the buffer', async () => {
		const bus = new EventBus({ capacity: 2 });
		bus.publish('agent.presence', { agentId: 'a1', sessionId: 's1', online: true });
		bus.publish('agent.presence', { agentId: 'a1', sessionId: 's1', online: false });
		bus.publish('agent.presence', { agentId: 'a1', sessionId: 's1', online: true });

		const parked = bus.waitFor({ types: ['request.answered'], since: 1, timeoutMs: 55_000 });
		const published = bus.publish('request.answered', settled);

		await expect(parked).resolves.toEqual(published);
	});

	it('watches every event type when none is named', async () => {
		const bus = new EventBus();
		const parked = bus.waitFor({ timeoutMs: 1_000 });

		const published = bus.publish('task.updated', {
			taskId: 't1',
			projectId: 'p1',
			agentId: 'ag1',
			state: 'claimed'
		});

		await expect(parked).resolves.toEqual(published);
	});

	it('gives up and unparks when the caller aborts', async () => {
		const bus = new EventBus();
		const controller = new AbortController();
		const parked = bus.waitFor({
			types: ['request.answered'],
			timeoutMs: 55_000,
			signal: controller.signal
		});

		controller.abort();

		await expect(parked).resolves.toBeUndefined();
		expect(bus.listenerCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('resolves immediately for a signal that is already aborted', async () => {
		const bus = new EventBus();

		await expect(
			bus.waitFor({ timeoutMs: 55_000, signal: AbortSignal.abort() })
		).resolves.toBeUndefined();
		expect(bus.listenerCount).toBe(0);
	});
});

describe('the shared bus', () => {
	it('is one instance for the whole process', async () => {
		const again = await import('./bus');

		expect(again.bus).toBe(sharedBus);
		expect(sharedBus).toBeInstanceOf(EventBus);
	});
});
