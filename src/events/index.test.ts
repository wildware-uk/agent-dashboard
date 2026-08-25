import { describe, expect, it } from 'vitest';
import * as events from './index';
import { EventBus, bus } from './bus';

describe('the $events entry point', () => {
	it('exposes the bus, the class, and the buffer size', () => {
		expect(events.bus).toBe(bus);
		expect(events.EventBus).toBe(EventBus);
		expect(events.RING_CAPACITY).toBe(500);
	});

	it('exports nothing else at runtime, so the surface stays the documented one', () => {
		expect(Object.keys(events).sort()).toEqual(['EventBus', 'RING_CAPACITY', 'bus']);
	});
});
