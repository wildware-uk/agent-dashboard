<script lang="ts">
	/**
	 * One cell of a card's media grid (design §6, §7).
	 *
	 * The cell is a box first and a picture second. Its aspect ratio is set from
	 * the *stored* dimensions before anything is fetched, so the space an image
	 * will take is already reserved at first paint and the timeline never jumps
	 * as thumbnails arrive — and, just as importantly, a placeholder occupies the
	 * same box it will occupy once it has swapped.
	 *
	 * Four states, and three of them are the ones a shortcut skips:
	 *
	 * - `pending` — the pipeline has not run. A labelled placeholder, and
	 *   deliberately **not** an `<img>` with no source, which is a broken image
	 *   in every browser.
	 * - `failed` — it will never render. Said in words (design §7), for the same
	 *   reason: every `/media/:id/:variant` 404s for a failed row
	 *   (`src/media/serve.ts`), so anything image-shaped here would be a broken
	 *   icon and a mystery.
	 * - `ready` image — the 640w thumbnail, with the 1600w one offered through
	 *   `srcset`, inside the button that opens the lightbox.
	 * - `ready` video — an inline player showing its poster frame, with
	 *   `preload="none"` so a 200MB clip costs one jpeg until somebody presses
	 *   play.
	 */
	import {
		durationLabel,
		intrinsic,
		mediaLabel,
		posterSrc,
		thumbSrc,
		thumbSrcset,
		tileRatio,
		videoSrc
	} from './media';
	import type { MediaView } from './types';

	let {
		item,
		/** Position in the grid, for the label a screen reader hears. */
		index,
		/** How many items the grid holds: what decides the cell's shape. */
		total,
		/** Called with this item's id when the owner opens it. */
		onopen
	}: {
		item: MediaView;
		index: number;
		total: number;
		onopen?: (id: string) => void;
	} = $props();

	const label = $derived(mediaLabel(item, index, total));
	const ratio = $derived(tileRatio(item, total));
	const size = $derived(intrinsic(item));
	const duration = $derived(durationLabel(item.durationMs));
	const src = $derived(thumbSrc(item));
	const poster = $derived(posterSrc(item));
	const source = $derived(videoSrc(item));

	/**
	 * What width the picture will actually be rendered at.
	 *
	 * The card is a `max-w-3xl` column, so a lone image is at most ~42rem and a
	 * cell of a three-across grid is a third of that. Without this the browser
	 * assumes the full viewport width and fetches the 1600w file for a thumbnail.
	 */
	const sizes = $derived(
		total > 1 ? '(min-width: 640px) 14rem, 30vw' : '(min-width: 640px) 42rem, 100vw'
	);
</script>

<div
	data-media-tile={item.id}
	data-media-state={item.status}
	data-media-kind={item.kind}
	style="aspect-ratio: {ratio}"
	class="relative overflow-hidden rounded-md border border-border-subtle bg-surface-sunken"
>
	{#if item.status === 'pending'}
		<div
			role="img"
			aria-label={label}
			class="absolute inset-0 flex animate-pulse flex-col items-center justify-center gap-1.5 text-content-muted"
		>
			<svg class="size-5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zM3.5 3a.5.5 0 0 0-.5.5v6.9l2.6-2.6a.5.5 0 0 1 .7 0l2.2 2.2 1.7-1.7a.5.5 0 0 1 .7 0L13 10.4V3.5a.5.5 0 0 0-.5-.5zM6 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0"
				/>
			</svg>
			<span class="text-xs">Processing…</span>
		</div>
	{:else if item.status === 'failed'}
		<div
			role="img"
			aria-label={label}
			class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-center text-content-muted"
		>
			<svg class="size-5 text-rose-500" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M8 1.5 15 14H1zm0 3.7a.75.75 0 0 0-.75.75V10a.75.75 0 0 0 1.5 0V5.95A.75.75 0 0 0 8 5.2M8 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2"
				/>
			</svg>
			<span class="text-xs">Media unavailable</span>
		</div>
	{:else if item.kind === 'video' && source}
		<!--
			Inline, from the poster frame (design §7). `preload="none"` is the point
			of having generated a poster at all: the card costs one jpeg until the
			owner presses play.
		-->
		<!--
			There is no caption track to point at: the pipeline produces a poster and
			an h264 transcode (design §6), and nothing anywhere generates subtitles
			for an agent's screen recording.
		-->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={source}
			poster={poster ?? undefined}
			controls
			playsinline
			preload="none"
			aria-label={label}
			class="absolute inset-0 size-full bg-black object-contain"
		></video>
		{#if duration}
			<span
				class="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white tabular-nums"
			>
				{duration}
			</span>
		{/if}
	{:else if src}
		<button
			type="button"
			aria-label={label}
			onclick={() => onopen?.(item.id)}
			class="absolute inset-0 size-full cursor-zoom-in focus:outline-2 focus:-outline-offset-2 focus:outline-accent"
		>
			<img
				{src}
				srcset={thumbSrcset(item)}
				{sizes}
				alt=""
				width={size?.width}
				height={size?.height}
				loading="lazy"
				decoding="async"
				class="size-full object-cover"
			/>
		</button>
	{/if}
</div>
