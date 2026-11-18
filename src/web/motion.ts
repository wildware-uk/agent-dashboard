/**
 * How much the dashboard moves (design §7).
 *
 * The owner: "can we make the dashboard more animated, cards flow to the top
 * when they are updated, spinners and loading and thinking bars are animated
 * etc."
 *
 * Two rules hold the whole thing together.
 *
 * **Motion says something.** A card slides because it moved, a bar shimmers
 * because something is actually happening. Decoration that moves for its own
 * sake is noise on a page somebody reads all day.
 *
 * **Anybody who has asked for less gets none.** `prefers-reduced-motion` is set
 * by people who get motion sick or lose their place on a page that shifts, so
 * every duration here collapses to zero rather than to "a bit quicker". That is
 * read at the moment the animation starts rather than cached, because the
 * setting can change under a running page.
 */

/** Whether this browser has asked for less movement. */
export function prefersReducedMotion(): boolean {
	try {
		return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	} catch {
		// No `matchMedia` (a server render, an old browser): animate normally.
		return false;
	}
}

/** A duration in milliseconds, or none at all for a reader who asked for calm. */
export function motionMs(ms: number): number {
	return prefersReducedMotion() ? 0 : ms;
}

/** How long a card takes to slide to its new place. */
export const FLOW_MS = 280;

/** How long a card stays marked as "this one just moved". */
export const BUMP_MS = 1_400;
