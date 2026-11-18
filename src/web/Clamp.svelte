<script lang="ts">
	/**
	 * Long content, shortened until somebody asks for the rest (design §7).
	 *
	 * The owner: "shorten the message content, if its too long." Their feed is
	 * long reports and long threads, and a card that runs to three screens pushes
	 * everything else below the fold whether or not it is the thing being read.
	 *
	 * **Only when it is actually too long.** The content is rendered as it is and
	 * then measured: a card that fits is untouched, with no button and no fade, so
	 * the ordinary short update reads exactly as it always did. Measuring rather
	 * than counting characters is what makes that honest — a wide screen fits more
	 * words, and a code block or an image is tall in a way a character count
	 * cannot see.
	 *
	 * Re-measured whenever the content changes size: an image that finished
	 * loading, an embed that painted, a window that was resized. Otherwise a card
	 * would be clamped for a height it no longer has, with a button that reveals
	 * nothing.
	 */
	import type { Snippet } from 'svelte';

	let {
		/** What to show. Clamped only if it turns out to be taller than `max`. */
		children,
		/**
		 * The tallest this may be before it is folded, in pixels.
		 *
		 * Deliberately generous: the point is to stop one card owning the screen,
		 * not to hide the second paragraph of everything.
		 */
		max = 420,
		/** What the control calls the thing being revealed. */
		noun = 'the rest'
	}: {
		children: Snippet;
		max?: number;
		noun?: string;
	} = $props();

	let content = $state<HTMLElement | null>(null);
	/** Whether the content is taller than the cap, measured rather than guessed. */
	let overflowing = $state(false);
	let open = $state(false);

	$effect(() => {
		const node = content;
		if (!node) return;

		const measure = () => {
			// `scrollHeight` is the whole content's height whether or not it is
			// currently clipped, which is exactly the question being asked.
			overflowing = node.scrollHeight > max + 8;
		};

		measure();
		// An image that loads late, an embed that paints, a window that resizes.
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});

	const clipped = $derived(overflowing && !open);
</script>

<div class="flex min-w-0 flex-col gap-1" data-clamp={clipped ? 'on' : undefined}>
	<div
		bind:this={content}
		class="relative min-w-0 {clipped ? 'overflow-hidden' : ''}"
		style={clipped ? `max-height: ${max}px` : undefined}
	>
		{@render children()}
		{#if clipped}
			<!--
				A fade rather than a hard cut, so it reads as "there is more" rather
				than as a card that was truncated by accident. Pointer events off: it
				sits over the content, and text under it stays selectable.
			-->
			<div
				aria-hidden="true"
				class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-surface-raised"
			></div>
		{/if}
	</div>

	{#if overflowing}
		<button
			type="button"
			data-testid="clamp-toggle"
			aria-expanded={open}
			onclick={() => (open = !open)}
			class="w-fit rounded px-1.5 py-0.5 text-xs font-medium text-content-muted hover:bg-surface hover:text-content"
		>
			{open ? 'Show less' : `Show ${noun}`}
		</button>
	{/if}
</div>
