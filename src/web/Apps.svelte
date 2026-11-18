<script lang="ts">
	/**
	 * The apps on one card (migration 041).
	 *
	 * A list and nothing else, the shape `Embeds.svelte` is: each showing carries
	 * the app it is of, so this fetches nothing and holds no registry, and a card
	 * arriving on the stream renders with no second thing to wait for.
	 */
	import AppFrame from './AppFrame.svelte';
	import { appsOnCard } from './apps';
	import type { OwnerActions } from './actions';
	import type { AppView } from './types';

	let {
		card,
		/** Every showing on this page; this one takes the ones on its card. */
		apps = [],
		actions
	}: {
		card: { kind: string; id: string };
		apps?: AppView[];
		actions?: OwnerActions;
	} = $props();

	const mine = $derived(appsOnCard(card, apps));
</script>

{#if mine.length > 0}
	<div data-apps class="flex flex-col gap-2">
		{#each mine as app (app.id)}
			<AppFrame {app} {actions} />
		{/each}
	</div>
{/if}
