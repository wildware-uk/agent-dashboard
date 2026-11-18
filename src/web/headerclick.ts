/**
 * Folding a card by clicking its header (design §7).
 *
 * The owner: "clicking on any empty part (or the title) of the header of a card
 * should collapse and expand it."
 *
 * The header is not empty, though — it carries the work-state chip, the pin, the
 * delete and the chevron, and every one of those is a click that must do its own
 * job. So this decides what counts as "the empty part": anything that is not
 * itself something to press, and not a click that was really a text selection.
 *
 * Written once rather than three times over, because a header that folded on an
 * update and swallowed the chip on a post would be the kind of difference the
 * card refactor exists to stop.
 */

/** Things a click belongs to, when it lands on one. */
const INTERACTIVE = 'button, a, input, select, textarea, summary, label, [role="button"]';

/**
 * Should this click on a card header fold the card?
 *
 * No when it landed on a control, no when the reader was selecting text (a drag
 * that ends in the header, or the double click that picks a word), yes
 * otherwise.
 */
export function foldsOnClick(event: MouseEvent): boolean {
	const target = event.target;
	if (!(target instanceof Element)) return false;
	if (target.closest(INTERACTIVE)) return false;
	// A double click is how a word is selected; folding underneath it would take
	// the card away mid-selection.
	if (event.detail > 1) return false;
	const selection = globalThis.getSelection?.();
	if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return false;
	return true;
}
