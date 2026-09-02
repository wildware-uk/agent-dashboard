import { describe, expect, it, vi } from 'vitest';
import { Clock } from './clock.svelte';

/**
 * One ticking clock for every relative timestamp on the page (design §7).
 *
 * The property worth protecting is that fifty cards cost one timer, not fifty —
 * and that the last card leaving takes the timer with it.
 */
function clockAt(start = 1_000) {
	let now = start;
	const ticking = new Clock({ clock: () => now, tickMs: 1_000 });
	return { ticking, advance: (ms: number) => (now += ms) };
}

describe('the shared clock', () => {
	it('starts at the real instant', () => {
		const { ticking } = clockAt(5_000);

		expect(ticking.now).toBe(5_000);
	});

	it('moves as the timer fires', () => {
		vi.useFakeTimers();
		const { ticking, advance } = clockAt();
		ticking.hold();

		advance(3_000);
		vi.advanceTimersByTime(3_000);

		expect(ticking.now).toBe(4_000);
		vi.useRealTimers();
	});

	it('runs one timer however many components are reading it', () => {
		vi.useFakeTimers();
		const spy = vi.spyOn(globalThis, 'setInterval');
		const { ticking } = clockAt();

		const holds = [ticking.hold(), ticking.hold(), ticking.hold()];

		expect(ticking.readers).toBe(3);
		expect(spy).toHaveBeenCalledTimes(1);
		holds.forEach((release) => release());
		spy.mockRestore();
		vi.useRealTimers();
	});

	it('stops when the last reader goes, rather than ticking for nobody', () => {
		vi.useFakeTimers();
		const { ticking, advance } = clockAt();
		const release = ticking.hold();

		release();
		advance(5_000);
		vi.advanceTimersByTime(5_000);

		expect(ticking.readers).toBe(0);
		expect(ticking.now).toBe(1_000);
		vi.useRealTimers();
	});

	it('is safe to release twice, as an unmount path may do', () => {
		const { ticking } = clockAt();
		const release = ticking.hold();

		release();
		release();

		expect(ticking.readers).toBe(0);
	});

	it('jumps to the real instant on demand, whatever the timer has been doing', () => {
		const { ticking, advance } = clockAt();
		ticking.hold();

		advance(60_000);
		ticking.sync();

		expect(ticking.now).toBe(61_000);
	});
});
