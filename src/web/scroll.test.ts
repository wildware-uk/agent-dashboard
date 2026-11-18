import { describe, expect, it, vi } from 'vitest';
import { SCREENS_BEFORE_OFFERING, scrollBehaviour, scrollToTop, shouldOfferTop } from './scroll';

/**
 * When to offer the way back to the top (design §7).
 *
 * The owner asked for "a floating button to scroll back to the top" when you are
 * scrolled down. The judgement worth stating is what "scrolled down" means, and
 * the answer is in screens rather than pixels: a fixed 600px rule appears halfway
 * down the first screen on a monitor and only after two swipes on a phone.
 */
describe('whether the reader is far enough down', () => {
	it('offers nothing until a whole screen has gone by', () => {
		expect(shouldOfferTop(0, 800)).toBe(false);
		expect(shouldOfferTop(799, 800)).toBe(false);
		expect(shouldOfferTop(801, 800)).toBe(true);
	});

	it('measures in screens, so a phone and a monitor agree', () => {
		// The same distance in screens, two very different distances in pixels.
		const phone = 640;
		const monitor = 1400;
		expect(shouldOfferTop(phone * 1.5, phone)).toBe(true);
		expect(shouldOfferTop(phone * 1.5, monitor)).toBe(false);
		expect(SCREENS_BEFORE_OFFERING).toBe(1);
	});

	it('says no before anything has been measured', () => {
		// A container with no height yet is one that has not been laid out, not one
		// somebody has scrolled to the bottom of.
		expect(shouldOfferTop(500, 0)).toBe(false);
	});
});

describe('how it moves', () => {
	it('glides by default', () => {
		vi.stubGlobal('matchMedia', () => ({ matches: false }));
		expect(scrollBehaviour()).toBe('smooth');
		vi.unstubAllGlobals();
	});

	it('jumps for somebody who asked their system for less motion', () => {
		// Not a degraded version of the animation: for somebody who gets motion
		// sick, jumping is the correct behaviour.
		vi.stubGlobal('matchMedia', () => ({ matches: true }));
		expect(scrollBehaviour()).toBe('auto');
		vi.unstubAllGlobals();
	});

	it('glides where nothing can be asked, rather than failing', () => {
		vi.stubGlobal('matchMedia', undefined);
		expect(scrollBehaviour()).toBe('smooth');
		vi.unstubAllGlobals();
	});

	it('takes the scroller to the top, and shrugs at not having one', () => {
		vi.stubGlobal('matchMedia', () => ({ matches: false }));
		const scrollTo = vi.fn();

		scrollToTop({ scrollTo });
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

		expect(() => scrollToTop(null)).not.toThrow();
		vi.unstubAllGlobals();
	});
});
