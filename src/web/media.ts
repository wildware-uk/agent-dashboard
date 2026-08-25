/**
 * The pure decisions behind the media grid and the lightbox (design §6, §7).
 *
 * Everything here is a function of one `MediaView` — no DOM, no store — which is
 * what lets the interesting rules be asserted on numbers in `media.test.ts`
 * rather than on rendered pixels.
 *
 * Two of those rules are the feature:
 *
 * **A cell's box is decided before anything loads.** {@link tileRatio} answers
 * from the *stored* dimensions, so the space an image will occupy is reserved by
 * CSS at first paint and the timeline does not jump when the bytes arrive. A
 * pending item has no dimensions yet — the pipeline is what measures them — so
 * it gets {@link DEFAULT_RATIO}, and a grid of several items gets one uniform
 * cell shape, which is decided for every state including the ones with nothing
 * to show.
 *
 * **The browser only ever asks for an address that exists.** `variants` says
 * which `/media/:id/:variant` will answer, and every source function reads it
 * rather than assuming. That is not belt-and-braces: a web-playable mp4 gets no
 * transcode (`src/media/derive.ts`), so `/media/:id/video` 404s for it and the
 * only playable source is the original. Guessing would give the owner a broken
 * player on exactly the videos that needed no work.
 */
import { base } from '$app/paths';
import type { MediaVariant, MediaView } from './types';

/** The shape a cell falls back to before the pipeline has measured anything. */
export const DEFAULT_RATIO = 4 / 3;

/** Every cell of a multi-item grid, so the grid is a grid and not a staircase. */
export const CELL_RATIO = 4 / 3;

/** Narrowest and widest box worth laying out: past these, a cell crops instead. */
export const MIN_RATIO = 0.6;
export const MAX_RATIO = 2.4;

/**
 * The address a variant is served at (design §6). The only URL rule in the client.
 *
 * Prefixed with `base` so a deployment under a sub-path serves rather than 404s,
 * and root-relative rather than through SvelteKit's `resolve`. `resolve` is the
 * right tool for a link, and the wrong one here: this project leaves
 * `paths.relative` at its default, so it answers with a path relative to the
 * page — `../media/…` on `/projects/x` — and the same string then means different
 * things in an `<img src>` on `/` and on `/projects/x`. An address that is
 * identical everywhere is also what makes the immutable cache headers on
 * `/media/:id/:variant` worth anything.
 */
export function mediaUrl(id: string, variant: MediaVariant): string {
	return `${base}/media/${id}/${variant}`;
}

/** Has the pipeline produced this variant? */
export function has(item: MediaView, variant: MediaVariant): boolean {
	return item.variants.includes(variant);
}

/** The first of these variants that exists, as a URL. */
function firstOf(item: MediaView, ...variants: MediaVariant[]): string | null {
	const found = variants.find((variant) => has(item, variant));
	return found ? mediaUrl(item.id, found) : null;
}

/** Only a `ready` row has anything to render; the rest have a state to show. */
function renderable(item: MediaView): boolean {
	return item.status === 'ready';
}

/**
 * The aspect ratio the cell reserves, as a number for `aspect-ratio`.
 *
 * `total` is how many items are in the grid, because that is what decides
 * whether a cell keeps its own shape or takes the uniform one.
 */
export function tileRatio(item: MediaView, total: number): number {
	if (total > 1) return CELL_RATIO;

	const { width, height } = item;
	if (width === null || height === null || width <= 0 || height <= 0) return DEFAULT_RATIO;

	return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height));
}

/**
 * The intrinsic size for the `width`/`height` attributes, or `null`.
 *
 * Set alongside the CSS box rather than instead of it: the attributes are what a
 * browser with CSS still loading uses to reserve space, and the aspect box is
 * what survives the image being resized by the grid.
 */
export function intrinsic(item: MediaView): { width: number; height: number } | null {
	const { width, height } = item;
	if (width === null || height === null || width <= 0 || height <= 0) return null;
	return { width, height };
}

/**
 * How many columns a grid of `count` items gets.
 *
 * Four is two-by-two rather than a row of four, because a card is at most a
 * `max-w-3xl` column: four across would make each shot a stamp.
 */
export function gridColumns(count: number): number {
	if (count <= 1) return 1;
	if (count === 2) return 2;
	if (count === 4) return 2;
	return 3;
}

/** What a grid cell shows for an image: the small thumbnail (design §6 step 4). */
export function thumbSrc(item: MediaView): string | null {
	if (!renderable(item)) return null;
	if (item.kind === 'video') return posterSrc(item);
	return firstOf(item, 'thumb-640', 'thumb-1600', 'original');
}

/** Both thumbnails as a `srcset`, so a wide screen or a 2x display gets the big one. */
export function thumbSrcset(item: MediaView): string | undefined {
	if (!renderable(item) || item.kind === 'video') return undefined;
	if (!has(item, 'thumb-640') || !has(item, 'thumb-1600')) return undefined;
	return `${mediaUrl(item.id, 'thumb-640')} 640w, ${mediaUrl(item.id, 'thumb-1600')} 1600w`;
}

/**
 * What the lightbox shows: the large thumbnail.
 *
 * Not the original, on purpose. A phone screenshot is a 2.4MB png and the 1600w
 * webp is a fraction of it at the size a screen can actually show; the original
 * is still one click away at its own address.
 */
export function viewSrc(item: MediaView): string | null {
	if (!renderable(item) || item.kind === 'video') return null;
	return firstOf(item, 'thumb-1600', 'original');
}

/** The playable source: the transcode if there is one, else the original. */
export function videoSrc(item: MediaView): string | null {
	if (!renderable(item) || item.kind !== 'video') return null;
	return firstOf(item, 'video', 'original');
}

/** The poster frame, which is what a video shows until it is played. */
export function posterSrc(item: MediaView): string | null {
	if (!renderable(item)) return null;
	return firstOf(item, 'poster');
}

/** Is this something the lightbox can enlarge? Video plays where it sits. */
export function isViewable(item: MediaView): boolean {
	return viewSrc(item) !== null;
}

/** `m:ss`, or nothing when the pipeline could not measure a duration. */
export function durationLabel(ms: number | null): string | null {
	if (ms === null || ms <= 0) return null;
	const total = Math.round(ms / 1000);
	const seconds = total % 60;
	return `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}`;
}

/**
 * What a screen reader is told about one item.
 *
 * A position, not a name: the agent's filename is a label that is stored nowhere
 * at all (`src/media/paths.ts`), so there is nothing else honest to say — and a
 * state, because "image 1 of 3" beside an empty box is not the whole truth.
 */
export function mediaLabel(item: MediaView, index: number, total: number): string {
	const noun = item.kind === 'video' ? 'Video' : 'Image';
	const position = `${noun} ${index + 1} of ${total}`;
	if (item.status === 'pending') return `${position}, still processing`;
	if (item.status === 'failed') return `${position}, could not be processed`;
	return position;
}
