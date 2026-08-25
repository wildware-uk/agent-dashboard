<script lang="ts">
	/**
	 * The centre column: the update timeline, grouped by day (design §7).
	 *
	 * This component owns the scroll container, which is what makes the live
	 * behaviour honest. The store is told whether the reader can see the top
	 * (`feed.hold`), and while they cannot, arrivals are held back and counted
	 * instead of being inserted — so the "N new" pill is not a nicety, it is the
	 * only thing that moves, and the viewport cannot jump under the reader's
	 * hands.
	 */
	import type { Snippet } from 'svelte';
	import UpdateCard from './UpdateCard.svelte';
	import { groupByDay } from './days';
	import type { OwnerActions } from './actions';
	import type { Timeline } from './timeline.svelte';
	import type { UpdateView } from './types';

	let {
		feed,
		/**
		 * Agent id to display name, resolved by the shell from the timeline
		 * snapshot and from presence. A card with no entry here names its poster
		 * from the id instead, readably (see `agentLabel`).
		 */
		agentNames = {},
		/** Passed through to each card's media region. */
		media,
		/** The owner's write calls, passed to every card (design §7). */
		actions
	}: {
		feed: Timeline;
		agentNames?: Record<string, string>;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
	} = $props();

	/**
	 * How far from the top still counts as "at the top".
	 *
	 * A few pixels of overscroll or a rounding difference between browsers must
	 * not be read as "the reader has scrolled away", or the pill would appear for
	 * someone who is looking straight at the top of the feed.
	 */
	const AT_TOP_PX = 48;

	let viewport = $state<HTMLElement | null>(null);

	// Captured once. Re-reading the clock on every render would let a card slide
	// from "Today" to "Yesterday" mid-session, remounting the whole group.
	const renderedAt = Date.now();

	/**
	 * Pinned updates sort first (design §7), lifted clear of the day groups
	 * rather than reordered inside them.
	 *
	 * Sorting within a day would put a pinned update from three weeks ago at the
	 * top of *its* day and nowhere near the top of the feed, which is not what
	 * pinning it meant. So the pinned ones become their own section above
	 * everything, and the day groups render what is left — every card appears
	 * exactly once either way.
	 */
	const pinned = $derived(feed.items.filter((item) => item.pinned));
	const groups = $derived(
		groupByDay(
			feed.items.filter((item) => !item.pinned),
			renderedAt
		)
	);

	function onscroll() {
		if (viewport) feed.hold(viewport.scrollTop > AT_TOP_PX);
	}

	/**
	 * Note what is deliberately *not* here: the connection status. It lives in the
	 * shell header, outside this scroll container, because anything that can
	 * appear above the cards moves the timeline under a reader who is scrolled
	 * into it — which is the one thing this component exists to prevent.
	 */
	function showNew() {
		feed.flush();
		viewport?.scrollTo({ top: 0, behavior: 'smooth' });
	}
</script>

<div bind:this={viewport} {onscroll} class="h-full min-h-0 overflow-y-auto" data-timeline>
	<!--
		Zero-height sticky layer: the pill can appear and disappear without ever
		adding or removing layout, which is the whole point of it.
	-->
	<div class="pointer-events-none sticky top-0 z-10 h-0">
		<div class="flex justify-center pt-2">
			{#if feed.pendingCount > 0}
				<button
					type="button"
					onclick={showNew}
					class="update-enter pointer-events-auto rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-surface shadow-lg"
				>
					{feed.pendingCount} new {feed.pendingCount === 1 ? 'update' : 'updates'}
				</button>
			{/if}
		</div>
	</div>

	<div class="mx-auto flex max-w-3xl flex-col gap-6 px-3 py-4 sm:px-4">
		{#if pinned.length > 0}
			<section class="flex flex-col gap-3" aria-labelledby="day-pinned">
				<h2
					id="day-pinned"
					class="sticky top-0 z-1 -mx-1 bg-surface/90 px-1 py-1 text-xs font-semibold tracking-wide text-accent uppercase backdrop-blur"
				>
					Pinned
				</h2>
				{#each pinned as update (update.id)}
					<UpdateCard
						{update}
						agentName={agentNames[update.agentId]}
						isNew={feed.isNew(update.id)}
						{media}
						{actions}
					/>
				{/each}
			</section>
		{/if}

		{#if groups.length === 0 && pinned.length === 0}
			<p class="px-1 py-8 text-content-muted">
				Nothing here yet. Agents connect over MCP at <code
					class="rounded bg-surface-raised px-1.5 py-0.5 text-sm">/mcp</code
				> and their updates stream in live.
			</p>
		{:else}
			{#each groups as group (group.key)}
				<section class="flex flex-col gap-3" aria-labelledby="day-{group.key}">
					<h2
						id="day-{group.key}"
						class="sticky top-0 z-1 -mx-1 bg-surface/90 px-1 py-1 text-xs font-semibold tracking-wide text-content-muted uppercase backdrop-blur"
					>
						{group.label}
					</h2>
					{#each group.items as update (update.id)}
						<UpdateCard
							{update}
							agentName={agentNames[update.agentId]}
							isNew={feed.isNew(update.id)}
							{media}
							{actions}
						/>
					{/each}
				</section>
			{/each}

			{#if feed.hasMore}
				<button
					type="button"
					onclick={() => feed.loadOlder()}
					disabled={feed.loading}
					class="mx-auto rounded border border-border-subtle px-3 py-1.5 text-sm text-content-muted hover:text-content disabled:opacity-50"
				>
					{feed.loading ? 'Loading…' : 'Load older updates'}
				</button>
			{/if}
		{/if}
	</div>
</div>
