/**
 * When to offer the way back to the top, and how to get there (design §7).
 *
 * The owner: "when you are scrolled down add a floating button to scroll back to
 * the top."
 *
 * Both decisions are small enough to state as functions, which is the point:
 * "how far is far enough" is a judgement worth being able to read and assert,
 * rather than a number buried in a scroll handler.
 */

/**
 * How far down counts as far enough to offer a way back.
 *
 * A whole screenful, not a fixed number of pixels. The distance that feels like
 * "I have gone somewhere" is the distance you have travelled *in screens*, and a
 * phone and a desktop disagree about that by a factor of three — a 600px rule
 * appears halfway down the first screen on a monitor and only after two swipes
 * on a phone.
 *
 * One screen also has a plain meaning to the person doing the scrolling: the
 * button turns up exactly when what they started at has left the view.
 */
export const SCREENS_BEFORE_OFFERING = 1;

/**
 * Is the reader far enough down to want the way back?
 *
 * Takes the numbers rather than the element so the rule can be asserted without
 * a browser, and so that "far enough" has exactly one definition.
 */
export function shouldOfferTop(scrollTop: number, clientHeight: number): boolean {
	if (clientHeight <= 0) return false;
	return scrollTop > clientHeight * SCREENS_BEFORE_OFFERING;
}

/**
 * How to move, given what the reader has asked their system for.
 *
 * A long smooth scroll is the animation people most often turn off, and jumping
 * is not a degraded version of it — for somebody who gets motion sick it is the
 * correct behaviour. `matchMedia` is absent during server rendering and in some
 * test environments, so its absence means "no preference expressed" rather than
 * an error.
 */
export function scrollBehaviour(): ScrollBehavior {
	try {
		return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
	} catch {
		return 'smooth';
	}
}

/** Take a scroller back to the top, at whatever speed the reader asked for. */
export function scrollToTop(
	viewport: { scrollTo: (options: ScrollToOptions) => void } | null
): void {
	viewport?.scrollTo({ top: 0, behavior: scrollBehaviour() });
}
