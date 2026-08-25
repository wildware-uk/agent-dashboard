<script lang="ts">
	/**
	 * The media grid on an update card (design §7).
	 *
	 * It renders the rows the card was handed and nothing else — no fetching, no
	 * store — which is what makes the live swap free: the timeline store answers
	 * `media.ready` by refetching the page and replacing the update by id
	 * (`timeline.svelte.ts`), the new row carries its variants, and this grid
	 * re-renders the same keyed cells with something in them. No component here
	 * subscribes to anything, and nothing reloads.
	 *
	 * Two layout decisions, both about not moving:
	 *
	 * - Every cell's box comes from the stored dimensions (`MediaTile.svelte`), so
	 *   it is reserved before a byte is fetched.
	 * - Several items get a uniform cell and a column count rather than their own
	 *   shapes, because a card is a narrow column and a staircase of differently
	 *   shaped cells is not a grid. Updates here routinely carry three or four.
	 *
	 * The lightbox holds only what can be enlarged: video plays where it sits, so
	 * it is not a stop on the way through a card's images.
	 */
	import { tick } from 'svelte';
	import Lightbox from './Lightbox.svelte';
	import MediaTile from './MediaTile.svelte';
	import { gridColumns, isViewable } from './media';
	import type { MediaView } from './types';

	let { items = [] }: { items?: MediaView[] } = $props();

	const columns = $derived(gridColumns(items.length));
	const viewable = $derived(items.filter(isViewable));

	let root = $state<HTMLElement | null>(null);
	/** Which of `viewable` the lightbox is showing, or `null` when it is closed. */
	let open = $state<number | null>(null);
	/** The cell that opened it, so the focus can be handed back on close. */
	let openedFrom: string | null = null;

	function show(id: string): void {
		const found = viewable.findIndex((item) => item.id === id);
		if (found === -1) return;
		openedFrom = id;
		open = found;
	}

	async function close(): Promise<void> {
		open = null;
		const id = openedFrom;
		openedFrom = null;
		if (!id) return;

		// Back to the image that was clicked. Without this a keyboard reader is
		// dumped at the top of the document, having closed a dialog they opened
		// from somewhere down a long timeline. Matched by attribute rather than by
		// selector so an id never has to be escaped into one.
		await tick();
		const cells = root?.querySelectorAll<HTMLElement>('[data-media-tile]') ?? [];
		for (const cell of cells) {
			if (cell.getAttribute('data-media-tile') !== id) continue;
			cell.querySelector('button')?.focus();
			return;
		}
	}
</script>

{#if items.length > 0}
	<div
		bind:this={root}
		data-media-grid
		data-media-count={items.length}
		class="grid gap-1.5"
		style="grid-template-columns: repeat({columns}, minmax(0, 1fr))"
	>
		{#each items as item, index (item.id)}
			<MediaTile {item} {index} total={items.length} onopen={show} />
		{/each}
	</div>

	{#if open !== null && viewable.length > 0}
		<Lightbox items={viewable} index={open} onclose={close} />
	{/if}
{/if}
