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
export function mediaUrl(id: string, variant: MediaVariant, prefix = ''): string {
	return `${base}${prefix}/media/${id}/${variant}`;
}

/** Has the pipeline produced this variant? */
export function has(item: MediaView, variant: MediaVariant): boolean {
	return item.variants.includes(variant);
}

/** The first of these variants that exists, as a URL. */
function firstOf(item: MediaView, prefix: string, ...variants: MediaVariant[]): string | null {
	const found = variants.find((variant) => has(item, variant));
	return found ? mediaUrl(item.id, found, prefix) : null;
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
 * How tall a lone upright item is allowed to get.
 *
 * A card is a wide column, so a portrait clip handed the full width becomes a
 * tower: a 9:16 capture at 42rem is over 1100px tall, which pushes everything
 * after it off the screen and makes the owner scroll past one video to reach
 * the next card. The cap is applied as a *width* limit rather than a height one
 * ({@link tileMaxWidth}) because the box keeps its aspect ratio either way, and
 * capping the height instead would letterbox the clip inside a box wider than
 * itself.
 */
export const UPRIGHT_CAP = 'min(26rem, 65vh)';

/**
 * The widest a cell may be, as a CSS length, or `null` for no limit.
 *
 * Only a lone upright item is limited. A grid of several already uses the
 * uniform landscape cell, and a landscape item is bounded by the column.
 */
export function tileMaxWidth(item: MediaView, total: number): string | null {
	const ratio = tileRatio(item, total);
	if (ratio >= 1) return null;

	return `calc(${ratio} * ${UPRIGHT_CAP})`;
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

/**
 * The three parts of a card's attachments, each shown the way it is used.
 *
 * A `file` is not a picture and does not belong in a grid of squares — a zip in
 * a 4:3 cell would be an empty box with a name in it. So the grid keeps images
 * and video, and files are listed underneath as rows you can read the name of
 * (migration 026).
 *
 * Sound is its own part for the same reason (migration 038). There is nothing to
 * look at, so a tile would be a black square; but there *is* something to do
 * with it, so a download row would bury the one thing the owner wants, which is
 * a play button. The owner: "sound files, that can be played directly in the
 * dashboard."
 */
export function splitMedia(items: readonly MediaView[]): {
	tiles: MediaView[];
	sounds: MediaView[];
	files: MediaView[];
} {
	return {
		tiles: items.filter((item) => item.kind === 'image' || item.kind === 'video'),
		sounds: items.filter((item) => item.kind === 'audio'),
		files: items.filter((item) => item.kind === 'file')
	};
}

/**
 * Where a file is downloaded from.
 *
 * The same closed address as everything else — `original` is the only variant a
 * file has — and the response carries `Content-Disposition: attachment`
 * (`src/http/media/serve.ts`), so the browser saves it rather than showing it.
 * That is the server's decision, not this link's: a `download` attribute here
 * would be a hint, and the header is the rule.
 */
export function downloadUrl(item: MediaView, prefix = ''): string | null {
	if (item.kind !== 'file' || !has(item, 'original')) return null;
	return mediaUrl(item.id, 'original', prefix);
}

/** What to call a file on screen when nobody wrote a name down. */
export const UNNAMED_FILE = 'Untitled file';

/** The name a file tile shows. */
export function fileName(item: MediaView): string {
	const name = item.filename?.trim();
	return name && name.length > 0 ? name : UNNAMED_FILE;
}

/**
 * A size somebody can read at a glance: `4 KB`, `1.4 MB`.
 *
 * Powers of 1024 with the usual short units, one decimal place only where it
 * changes the answer. Zero is "empty" rather than "0 B", because a zero-byte
 * download is a thing worth noticing rather than a measurement.
 */
export function fileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return 'empty';
	if (bytes < 1024) return `${Math.round(bytes)} B`;

	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a grid cell shows for an image: the small thumbnail (design §6 step 4). */
export function thumbSrc(item: MediaView, prefix = ''): string | null {
	if (!renderable(item) || item.kind === 'file' || item.kind === 'audio') return null;
	if (item.kind === 'video') return posterSrc(item, prefix);
	return firstOf(item, prefix, 'thumb-640', 'thumb-1600', 'original');
}

/** Both thumbnails as a `srcset`, so a wide screen or a 2x display gets the big one. */
export function thumbSrcset(item: MediaView, prefix = ''): string | undefined {
	if (!renderable(item) || item.kind === 'video') return undefined;
	if (!has(item, 'thumb-640') || !has(item, 'thumb-1600')) return undefined;
	return (
		`${mediaUrl(item.id, 'thumb-640', prefix)} 640w, ` +
		`${mediaUrl(item.id, 'thumb-1600', prefix)} 1600w`
	);
}

/**
 * What the lightbox shows: the large thumbnail.
 *
 * Not the original, on purpose. A phone screenshot is a 2.4MB png and the 1600w
 * webp is a fraction of it at the size a screen can actually show; the original
 * is still one click away at its own address.
 */
export function viewSrc(item: MediaView, prefix = ''): string | null {
	// A file is a download, never a picture to enlarge — even though `original`
	// answers for one, which is exactly the trap this guard exists for.
	if (!renderable(item) || item.kind !== 'image') return null;
	return firstOf(item, prefix, 'thumb-1600', 'original');
}

/** The playable source: the transcode if there is one, else the original. */
export function videoSrc(item: MediaView, prefix = ''): string | null {
	if (!renderable(item) || item.kind !== 'video') return null;
	return firstOf(item, prefix, 'video', 'original');
}

/**
 * The playable source for a sound (migration 038).
 *
 * The original, always: every type on the audio allowlist is one a browser
 * plays as it stands, so nothing is transcoded and there is no second address to
 * choose between.
 */
export function audioSrc(item: MediaView, prefix = ''): string | null {
	if (!renderable(item) || item.kind !== 'audio') return null;
	return firstOf(item, prefix, 'original');
}

/** The poster frame, which is what a video shows until it is played. */
export function posterSrc(item: MediaView, prefix = ''): string | null {
	if (!renderable(item)) return null;
	return firstOf(item, prefix, 'poster');
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
	// A file has a name, which is the one attachment that can say what it is.
	if (item.kind === 'file') {
		const position = `${fileName(item)}, ${fileSize(item.bytes)}`;
		if (item.status === 'pending') return `${position}, still being stored`;
		if (item.status === 'failed') return `${position}, could not be stored`;
		return `Download ${position}`;
	}

	if (item.kind === 'audio') {
		const length = durationLabel(item.durationMs ?? null);
		const position = `Sound ${index + 1} of ${total}${length ? `, ${length}` : ''}`;
		if (item.status === 'pending') return `${position}, still processing`;
		if (item.status === 'failed') return `${position}, could not be processed`;
		return position;
	}

	const noun = item.kind === 'video' ? 'Video' : 'Image';
	const position = `${noun} ${index + 1} of ${total}`;
	if (item.status === 'pending') return `${position}, still processing`;
	if (item.status === 'failed') return `${position}, could not be processed`;
	return position;
}
