<script lang="ts">
	/**
	 * The embeds on a card or a message (migration 027).
	 *
	 * A list and nothing else: each one carries the look it is drawn in, so this
	 * fetches nothing and holds no registry. That is what lets a card arriving on
	 * the stream render on its own, with nothing else to wait for.
	 */
	import Embed from './Embed.svelte';
	import type { EmbedView } from './types';

	let { items = [] }: { items?: EmbedView[] } = $props();
</script>

{#if items.length > 0}
	<div data-embeds class="flex flex-col gap-2">
		{#each items as embed (embed.id)}
			<Embed {embed} />
		{/each}
	</div>
{/if}
