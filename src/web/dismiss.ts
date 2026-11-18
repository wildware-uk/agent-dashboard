/**
 * Closing a small panel the way people expect (design §7).
 *
 * The owner: "clicking anywhere should dismiss the tag setting popup."
 *
 * Two ways out, because a panel with only one is a panel somebody gets stuck
 * in: a press anywhere else, and Escape.
 *
 * ## Why `pointerdown` rather than `click`
 *
 * A click fires after the press, and after whatever the press did to the DOM. On
 * a panel like this the press is often what removes the element under the
 * pointer, and the click then lands on nothing at all — so the panel never hears
 * it. `pointerdown` is also what a person reads as "I have started pressing
 * something else".
 *
 * ## Why the trigger is ignored
 *
 * The button that opens the panel is outside it, so without this an open panel
 * would close on `pointerdown` and the button's own `click` would open it again
 * a moment later: pressing the button while it is open would look like nothing
 * happening. Handing the trigger in keeps the toggle a toggle.
 */
export type DismissOptions = {
	/** Called when the reader has pressed elsewhere, or hit Escape. */
	onclose: () => void;
	/** The control that opened this, so its own toggle still works. */
	ignore?: HTMLElement | null;
	/** Off while the panel is closed, so nothing listens for nothing. */
	enabled?: boolean;
};

export function dismissable(node: HTMLElement, options: DismissOptions) {
	let current = options;

	function outside(event: Event): void {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (node.contains(target)) return;
		if (current.ignore?.contains(target)) return;
		current.onclose();
	}

	function escape(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		// Stopped here so one Escape closes one thing: the shell closes its drawer
		// on the same key, and a reader dismissing a panel has not asked for that.
		event.stopPropagation();
		current.onclose();
	}

	function listen(): void {
		// Capture, so a handler that stops the event on its way up cannot leave
		// the panel open for ever.
		document.addEventListener('pointerdown', outside, true);
		document.addEventListener('keydown', escape, true);
	}

	function stop(): void {
		document.removeEventListener('pointerdown', outside, true);
		document.removeEventListener('keydown', escape, true);
	}

	if (current.enabled !== false) listen();

	return {
		update(next: DismissOptions) {
			current = next;
			stop();
			if (next.enabled !== false) listen();
		},
		destroy: stop
	};
}
