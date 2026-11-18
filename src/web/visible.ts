/**
 * "The reader has actually looked at this card."
 *
 * Used by the unread-comment badge (`unread.svelte.ts`): a badge that cleared
 * because the card exists somewhere on a 90-card page would never be true, and
 * one that needed a click to clear would be the "mark as read" button the owner
 * had just asked to be rid of. So a card clears itself by being on screen, and
 * only after it has stayed there — scrolling past at speed is not reading.
 *
 * An `IntersectionObserver` rather than a scroll handler: the browser works out
 * what is on screen anyway, and doing it again per card per frame is how a long
 * feed starts to stutter.
 */
export type VisibleOptions = {
	/** Called once the node has been on screen for {@link VisibleOptions.dwellMs}. */
	onvisible: () => void;
	/** Off while there is nothing to clear, so the common card costs nothing. */
	enabled?: boolean;
	/** How long it has to stay there. Long enough that a fast scroll misses it. */
	dwellMs?: number;
	/**
	 * The band of the screen a card has to reach, as a margin on the viewport.
	 *
	 * A *fraction of the card* is the obvious rule and it is wrong: a long report
	 * with a long thread under it is taller than the screen, so "20% of this
	 * element is showing" can be impossible to satisfy and the card is never
	 * marked read. The owner found exactly that — "the unread replies badge on
	 * cards never seems to disappear". A band of the *viewport* does not care how
	 * tall the card is: any part of it reaching the middle of the screen counts.
	 */
	band?: string;
};

const DWELL_MS = 700;
const BAND = '-15% 0px -15% 0px';

export function whenVisible(node: HTMLElement, options: VisibleOptions) {
	let current = options;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let observer: IntersectionObserver | undefined;

	function stop() {
		clearTimeout(timer);
		timer = undefined;
		observer?.disconnect();
		observer = undefined;
	}

	function start() {
		if (observer || current.enabled === false) return;
		// Nothing to observe with (an old browser, a server-rendered pass): treat
		// the card as looked at rather than badging it for ever.
		if (typeof IntersectionObserver === 'undefined') {
			current.onvisible();
			return;
		}
		observer = new IntersectionObserver(
			(entries) => {
				const showing = entries.some((entry) => entry.isIntersecting);
				if (!showing) {
					clearTimeout(timer);
					timer = undefined;
					return;
				}
				if (timer) return;
				timer = setTimeout(() => {
					timer = undefined;
					current.onvisible();
				}, current.dwellMs ?? DWELL_MS);
			},
			{ threshold: 0, rootMargin: current.band ?? BAND }
		);
		observer.observe(node);
	}

	start();

	return {
		update(next: VisibleOptions) {
			current = next;
			if (next.enabled === false) stop();
			else start();
		},
		destroy: stop
	};
}
