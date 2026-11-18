import { describe, expect, it, vi } from 'vitest';
import { FLOW_MS, motionMs, prefersReducedMotion } from './motion';
import { Bumps } from './bumps.svelte';

/**
 * How much the dashboard moves (design §7).
 *
 * The owner: "can we make the dashboard more animated, cards flow to the top
 * when they are updated."
 */
describe('asking for less movement', () => {
	it('reads the browser’s setting, and animates when it is not set', () => {
		expect(typeof prefersReducedMotion()).toBe('boolean');
		expect(motionMs(FLOW_MS)).toBe(prefersReducedMotion() ? 0 : FLOW_MS);
	});

	it('collapses a duration to nothing when the reader asked for calm', () => {
		const media = vi
			.spyOn(globalThis, 'matchMedia')
			.mockReturnValue({ matches: true } as MediaQueryList);

		expect(motionMs(300)).toBe(0);

		media.mockRestore();
	});
});

describe('marking the card that moved', () => {
	it('says nothing about a card it is meeting for the first time', () => {
		const bumps = new Bumps(50);
		bumps.note('c1', 100);

		expect(bumps.has('c1')).toBe(false);
	});

	it('marks a card whose activity moved forward', () => {
		const bumps = new Bumps(50);
		bumps.note('c1', 100);
		bumps.note('c1', 200);

		expect(bumps.has('c1')).toBe(true);
	});

	it('says nothing when the card has not moved', () => {
		const bumps = new Bumps(50);
		bumps.note('c1', 100);
		bumps.note('c1', 100);

		expect(bumps.has('c1')).toBe(false);
	});

	it('takes the mark off again, because “just moved” stops being true', async () => {
		const bumps = new Bumps(20);
		bumps.note('c1', 100);
		bumps.note('c1', 200);

		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(bumps.has('c1')).toBe(false);
	});

	it('keeps cards apart', () => {
		const bumps = new Bumps(50);
		bumps.note('c1', 100);
		bumps.note('c2', 100);
		bumps.note('c1', 200);

		expect(bumps.has('c1')).toBe(true);
		expect(bumps.has('c2')).toBe(false);
		bumps.stop();
	});
});
