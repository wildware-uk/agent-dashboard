<script lang="ts">
	/**
	 * One update in the timeline (design §7).
	 *
	 * Level colour down the left edge, a name-hashed avatar, the markdown body,
	 * and a media region that stays empty until the media slice fills it. The
	 * card renders from the row and nothing else — no fetching, no store — so it
	 * is the same component whether it arrived in the server render or over the
	 * stream.
	 */
	import type { Snippet } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { agentLabel } from './avatar';
	import Markdown from './Markdown.svelte';
	import MediaGrid from './MediaGrid.svelte';
	import UpdateActions from './UpdateActions.svelte';
	import type { OwnerActions } from './actions';
	import { timeLabel } from './days';
	import { levelStyle } from './levels';
	import type { UpdateView } from './types';

	let {
		update,
		/**
		 * What to call the poster.
		 *
		 * Resolved by the shell from the timeline snapshot (every agent this
		 * deployment knows, offline and revoked included) and from presence (an
		 * agent that registered a session since the page loaded). Absent only for
		 * an agent neither of those can name, which {@link agentLabel} then renders
		 * as a short readable id rather than 26 characters of ULID.
		 */
		agentName,
		/** Arrived over the stream, so it animates in exactly once. */
		isNew = false,
		/**
		 * An override for the media region (design §7).
		 *
		 * Left in place now that the region has real contents: the card renders
		 * {@link MediaGrid} from `update.media` by default, and a snippet replaces
		 * it — which is what keeps the card renderable in a context that wants
		 * something else there without the grid having to know about it.
		 */
		media,
		/**
		 * The owner's write calls (design §7). Given one, the card grows a pin and
		 * a delete; without one it renders exactly as it always has, which is what
		 * keeps every existing card spec honest.
		 */
		actions
	}: {
		update: UpdateView;
		agentName?: string;
		isNew?: boolean;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
	} = $props();

	const level = $derived(levelStyle(update.level));
	const poster = $derived(agentLabel(update.agentId, agentName));
</script>

<article
	class="relative flex gap-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-3 pr-4 pl-5 {isNew
		? 'update-enter'
		: ''}"
	data-level={update.level}
	data-update-id={update.id}
	aria-label="{level.label} update from {poster}"
	data-pinned={update.pinned ? 'true' : undefined}
>
	<!-- The level colour: the thing a long timeline is scanned by. -->
	<span class="absolute inset-y-0 left-0 w-1.5 {level.bar}" aria-hidden="true"></span>

	<Avatar name={poster} />

	<div class="flex min-w-0 flex-1 flex-col gap-2">
		<header class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
			<span class="font-medium text-content">{poster}</span>
			<span class="rounded px-1.5 py-0.5 text-xs font-medium {level.badge}">{level.label}</span>
			{#if update.pinned}
				<!--
					Stated on the card itself, not only in the ordering: a reader who
					lands mid-feed has to be able to tell why this one is at the top.
				-->
				<span class="flex items-center gap-1 text-xs font-medium text-accent">
					<svg class="size-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<path
							d="M9.5 1.5 14.5 6.5l-1.8.4-2.3 2.3.7 3.6-1.1 1.1L6.6 10 3 13.6 2 12.6l3.6-3.6L1.7 5.1l1.1-1.1 3.6.7 2.3-2.3z"
						/>
					</svg>
					Pinned
				</span>
			{/if}
			<time
				class="ml-auto text-xs text-content-muted"
				datetime={new Date(update.createdAt).toISOString()}
			>
				{timeLabel(update.createdAt)}
			</time>
			{#if actions}
				<UpdateActions {update} {actions} />
			{/if}
		</header>

		{#if update.title}
			<h3 class="text-base font-semibold tracking-tight text-content">{update.title}</h3>
		{/if}

		<Markdown body={update.body} />

		<!--
			Media region (design §7): the grid, sized from the stored dimensions, and
			the lightbox it opens.

			The card still renders from the row and nothing else, which is the whole
			of the live swap: `media.ready` makes the store refetch and replace this
			update by id (`timeline.svelte.ts`), the replacement carries its variants,
			and the placeholder becomes the image with nothing here subscribing to
			anything and no reload.
		-->
		<div data-media-region class="contents">
			{#if media}
				{@render media(update)}
			{:else}
				<MediaGrid items={update.media ?? []} />
			{/if}
		</div>
	</div>
</article>
