<script lang="ts">
	/**
	 * Full-size viewing (design §7).
	 *
	 * A modal that is entirely usable from the keyboard, because a lightbox that
	 * can be opened but not left is worse than no lightbox. Three rules:
	 *
	 * - **Escape closes**, and arrow keys, `Home` and `End` walk the card's
	 *   images as a ring. Wrapping rather than stopping: three shots are a loop
	 *   worth flicking through, and a dead end at either end is a key press that
	 *   silently does nothing.
	 * - **Focus starts inside and stays inside.** The dialog itself takes focus on
	 *   open so the first key press reaches it, and `Tab` is handled here rather
	 *   than by the browser, so it cannot wander into the timeline behind the
	 *   overlay — which is a list of things the reader cannot see.
	 * - **Focus goes back where it came from.** Not this component's job: the grid
	 *   knows which cell was opened and returns focus to it (`MediaGrid.svelte`).
	 *
	 * The image shown is the 1600w thumbnail, not the original — a phone
	 * screenshot is a 2.4MB png and no screen shows more than the large webp has —
	 * with the original one link away for anyone who wants the real file.
	 */
	import { mediaLabel, mediaUrl, viewSrc } from './media';
	import type { MediaView } from './types';

	let {
		/** Only what can be enlarged; the grid filters (video plays where it sits). */
		items,
		/** Which one to open on. */
		index = 0,
		onclose
	}: {
		items: MediaView[];
		index?: number;
		onclose: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let at = $state(index);
	let dialog = $state<HTMLElement | null>(null);

	const item = $derived(items[Math.min(at, items.length - 1)]);
	const label = $derived(item ? mediaLabel(item, at, items.length) : '');

	$effect(() => {
		// The first key press has to reach the dialog, and the reader has to be
		// somewhere they can see rather than in the page behind the overlay.
		dialog?.focus();
	});

	function go(step: number): void {
		at = (at + step + items.length) % items.length;
	}

	/**
	 * Everything inside the dialog a `Tab` may land on.
	 *
	 * Read from the DOM per press rather than tracked, because how many stops
	 * there are depends on what is rendered: a single image has no next button.
	 */
	function stops(): HTMLElement[] {
		if (!dialog) return [];
		return [
			...dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]):not([tabindex="-1"])'
			)
		];
	}

	function trap(event: KeyboardEvent): void {
		const ring = stops();
		event.preventDefault();
		if (ring.length === 0) {
			dialog?.focus();
			return;
		}

		const active = document.activeElement as HTMLElement | null;
		const from = active ? ring.indexOf(active) : -1;
		const step = event.shiftKey ? -1 : 1;
		const next = from === -1 ? (event.shiftKey ? ring.length - 1 : 0) : from + step;
		ring[(next + ring.length) % ring.length].focus();
	}

	function key(event: KeyboardEvent): void {
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				onclose();
				return;
			case 'ArrowRight':
			case 'ArrowDown':
				event.preventDefault();
				go(1);
				return;
			case 'ArrowLeft':
			case 'ArrowUp':
				event.preventDefault();
				go(-1);
				return;
			case 'Home':
				event.preventDefault();
				at = 0;
				return;
			case 'End':
				event.preventDefault();
				at = items.length - 1;
				return;
			case 'Tab':
				trap(event);
		}
	}
</script>

<svelte:window onkeydown={key} />

<div class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
	<!--
		The backdrop is a control so a click on it closes, and `tabindex="-1"` so it
		is not a stop on the way round: Escape and the close button are the keyboard
		ways out, and a tab ring with an invisible member in it is a puzzle. Named
		distinctly from the close button so a test can tell the two apart.
	-->
	<button
		type="button"
		tabindex="-1"
		aria-label="Dismiss media viewer"
		onclick={onclose}
		class="absolute inset-0 bg-black/80"
	></button>

	<div
		bind:this={dialog}
		role="dialog"
		aria-modal="true"
		aria-label="Media viewer"
		tabindex="-1"
		class="update-enter relative flex max-h-full min-w-0 flex-col items-center gap-3 focus:outline-none"
	>
		{#if item}
			{@const src = viewSrc(item)}
			{#if src}
				<img
					{src}
					alt={label}
					class="max-h-[80vh] max-w-full rounded-md object-contain shadow-2xl"
				/>
			{/if}

			<div
				class="flex w-full flex-wrap items-center justify-center gap-2 rounded-md bg-surface-raised/90 px-2 py-1.5 text-sm text-content-muted backdrop-blur"
			>
				{#if items.length > 1}
					<button
						type="button"
						aria-label="Previous image"
						onclick={() => go(-1)}
						class="rounded px-2 py-1 hover:text-content focus:outline-2 focus:outline-accent"
					>
						←
					</button>
				{/if}

				<span class="tabular-nums">{at + 1} of {items.length}</span>

				{#if items.length > 1}
					<button
						type="button"
						aria-label="Next image"
						onclick={() => go(1)}
						class="rounded px-2 py-1 hover:text-content focus:outline-2 focus:outline-accent"
					>
						→
					</button>
				{/if}

				<!--
					The original, for anyone who wants the real file. `mediaUrl` is the
					one place a media address is built and it already prefixes `base`
					(`./media.ts`), which is what the lint rule is protecting against and
					cannot see through. Deliberately not `resolve`: that answers with a
					path relative to the current page, and this address has to mean the
					same thing everywhere.
				-->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={mediaUrl(item.id, 'original')}
					target="_blank"
					rel="noreferrer"
					class="ml-auto rounded px-2 py-1 hover:text-content focus:outline-2 focus:outline-accent"
				>
					Original
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->

				<button
					type="button"
					onclick={onclose}
					class="rounded border border-border-subtle px-2 py-1 hover:text-content focus:outline-2 focus:outline-accent"
				>
					Close
				</button>
			</div>
		{/if}
	</div>
</div>
