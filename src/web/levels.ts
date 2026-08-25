/**
 * The four update levels as colour (design §7).
 *
 * Kept out of the card component so the palette is one table rather than a
 * chain of `{#if}`s, and so the colour and the word travel together: an
 * `error` card is red *and* says "Error", because colour alone is not an
 * accessible signal and a screenshot of a red card in a bug report should still
 * say what it was.
 *
 * These are Tailwind palette steps rather than the semantic surface tokens in
 * `app.css`: level colour is a fixed vocabulary, not a themeable surface, and
 * each step below is legible on both the light and the dark surface.
 */
import type { UpdateLevel } from './types';

export type LevelStyle = {
	/** Human-readable name, rendered next to the colour. */
	label: string;
	/** The card's left edge: the thing you scan a long timeline by. */
	bar: string;
	/** Small text badge in the card header. */
	badge: string;
};

export const LEVELS: Record<UpdateLevel, LevelStyle> = {
	info: {
		label: 'Info',
		bar: 'bg-sky-500',
		badge: 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
	},
	success: {
		label: 'Success',
		bar: 'bg-emerald-500',
		badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
	},
	warn: {
		label: 'Warning',
		bar: 'bg-amber-500',
		badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
	},
	error: {
		label: 'Error',
		bar: 'bg-rose-500',
		badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
	}
};

/** The style for a level, treating anything unexpected as `info`. */
export function levelStyle(level: UpdateLevel): LevelStyle {
	return LEVELS[level] ?? LEVELS.info;
}
