/**
 * How a tag looks, and which cards wear which (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 *
 * The colours are stated here rather than inline for the reason every colour in
 * this project is: the dashboard has two themes, so a tag is a *name* in the
 * data and a pair of classes here. A stored hex would be legible in one theme.
 */
import type { CardTagView, TagView } from './types';

/** The palette a tag may be painted in, keyed by the name the row stores. */
const LOOKS: Record<string, string> = {
	grey: 'bg-surface-sunken text-content-muted border-border-subtle',
	rose: 'bg-rose-500/15 text-rose-700 border-rose-500/40 dark:text-rose-300',
	amber: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300',
	green: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300',
	blue: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300',
	violet: 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'
};

/** The colour names the picker offers, in the order it offers them. */
export const TAG_COLOURS = Object.keys(LOOKS);

/** The classes a tag is drawn with. An unknown name falls back to grey. */
export function tagLook(colour: string | null | undefined): string {
	return LOOKS[colour ?? 'grey'] ?? LOOKS.grey;
}

/**
 * The tags on one card, in the order the project decided them.
 *
 * Ordering by the project's list rather than by when each was put on: a card
 * that always shows "bug" before "high priority" is one the eye can scan down a
 * feed, and the order tags were clicked in is not information anybody wants.
 */
export function tagsOn(
	card: { kind: string; id: string },
	worn: readonly CardTagView[],
	known: readonly TagView[]
): TagView[] {
	const ids = new Set(
		worn
			.filter((row) => row.card.kind === card.kind && row.card.id === card.id)
			.map((row) => row.tagId)
	);
	return known.filter((tag) => ids.has(tag.id));
}

/** The words a project has, for the picker on its cards. */
export function tagsFor(
	projectId: string | null | undefined,
	known: readonly TagView[]
): TagView[] {
	if (!projectId) return [];
	return known.filter((tag) => tag.projectId === projectId);
}
