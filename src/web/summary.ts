/**
 * One line of a card, for when the card is folded away (design §7).
 *
 * The owner: "allow me to collapse a card." A fold that showed nothing but a
 * name would be a row you have to open to find out whether you wanted it — so a
 * collapsed card keeps one line, and this is that line.
 *
 * It is not markdown rendering. A folded card is a label, and a label with a
 * heading, a bullet and half a code fence in it is worse than the plain words:
 * the few marks that carry meaning inline are stripped, the block marks are
 * dropped with their line, and the result is one run of text.
 */

/** How much of a body a folded card shows. About a line on a narrow screen. */
export const SUMMARY_MAX_LENGTH = 120;

/**
 * The first words of a body, as a single line.
 *
 * Empty for a body with nothing readable in it — an image-only post, say — and
 * the caller decides what to show instead, because "no words" means different
 * things on different cards.
 */
export function summaryOf(body: string, limit = SUMMARY_MAX_LENGTH): string {
	const flattened = body
		// Fenced code: its first line is a language, which says nothing.
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		// Images before links, so an image's alt text does not survive as words
		// the card never showed.
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Leading block marks: headings, quotes, bullets, numbered items.
		.replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
		// Inline emphasis and code, kept as their contents.
		.replace(/[*_~`]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (flattened.length <= limit) return flattened;
	// Cut on a word where there is one nearby, so the line does not end mid-word.
	const cut = flattened.slice(0, limit);
	const space = cut.lastIndexOf(' ');
	return `${(space > limit - 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "3 replies", "1 reply", or nothing at all. */
export function repliesLabel(count: number): string {
	if (count <= 0) return '';
	return count === 1 ? '1 reply' : `${count} replies`;
}
