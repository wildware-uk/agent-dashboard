import { describe, expect, it } from 'vitest';
import { EventRing } from './ring';
import type { AppEvent } from './types';

/** A published event with a given seq. The payload is irrelevant to the ring. */
function event(seq: number): AppEvent {
	return {
		type: 'project.created',
		seq,
		at: '2026-08-25T12:00:00.000Z',
		payload: { projectId: `p${seq}`, slug: `p-${seq}` }
	};
}

/** A ring holding `count` events numbered 1..count. */
function filled(count: number, capacity = 500): EventRing {
	const ring = new EventRing(capacity);
	for (let seq = 1; seq <= count; seq += 1) ring.push(event(seq));
	return ring;
}

describe('EventRing', () => {
	it('keeps only the last `capacity` events', () => {
		const ring = filled(12, 5);

		expect(ring.size).toBe(5);
		expect(ring.toArray().map((e) => e.seq)).toEqual([8, 9, 10, 11, 12]);
	});

	it('replays the gap after a seq that is still buffered', () => {
		const result = filled(10).since(7);

		expect(result).toEqual({ hit: true, events: [event(8), event(9), event(10)] });
	});

	it('replays an empty gap for a caller that is already up to date', () => {
		const result = filled(10).since(10);

		// An empty gap is a hit: the caller has everything and stays connected.
		expect(result).toEqual({ hit: true, events: [] });
	});

	it('replays the whole buffer for the oldest seq it can still serve', () => {
		// Buffer holds 8..12, so a caller that has seen 7 can be told everything since.
		const result = filled(12, 5).since(7);

		expect(result).toEqual({ hit: true, events: [8, 9, 10, 11, 12].map(event) });
	});

	it('reports a miss for a seq that has fallen out of the buffer', () => {
		// One older than the oldest servable seq: the gap would be partial.
		const result = filled(12, 5).since(6);

		expect(result).toEqual({ hit: false, reason: 'expired' });
	});

	it('reports a miss, not an empty gap, so resync is distinguishable', () => {
		const miss = filled(12, 5).since(1);
		const emptyGap = filled(12, 5).since(12);

		expect(miss.hit).toBe(false);
		expect(emptyGap).toEqual({ hit: true, events: [] });
	});

	it('serves a fresh caller from an empty ring', () => {
		expect(new EventRing(500).since(0)).toEqual({ hit: true, events: [] });
	});

	it('reports a miss for a caller ahead of the ring, as after a restart', () => {
		// The process restarted and the sequence began again; the browser is
		// holding a Last-Event-ID this ring never issued.
		expect(new EventRing(500).since(42)).toEqual({ hit: false, reason: 'ahead' });
		expect(filled(10).since(11)).toEqual({ hit: false, reason: 'ahead' });
	});

	it('exposes the seq range it can serve', () => {
		const ring = filled(12, 5);

		expect(ring.oldestSeq).toBe(8);
		expect(ring.newestSeq).toBe(12);
	});

	it('refuses a capacity below one', () => {
		expect(() => new EventRing(0)).toThrow(/capacity/i);
	});
});
