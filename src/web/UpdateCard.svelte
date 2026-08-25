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
	import Markdown from './Markdown.svelte';
	import { timeLabel } from './days';
	import { levelStyle } from './levels';
	import type { UpdateView } from './types';

	let {
		update,
		/**
		 * What to call the poster. Falls back to the agent id, which is still a
		 * stable key for the avatar hash; agent *names* arrive with the presence
		 * slice, and this prop is where they will land.
		 */
		agentName,
		/** Arrived over the stream, so it animates in exactly once. */
		isNew = false,
		/** The media grid (design §7). Rendered by the media-in-the-UI slice. */
		media
	}: {
		update: UpdateView;
		agentName?: string;
		isNew?: boolean;
		media?: Snippet<[UpdateView]>;
	} = $props();

	const level = $derived(levelStyle(update.level));
	const poster = $derived(agentName ?? update.agentId);
</script>

<article
	class="relative flex gap-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-3 pr-4 pl-5 {isNew
		? 'update-enter'
		: ''}"
	data-level={update.level}
	data-update-id={update.id}
	aria-label="{level.label} update from {poster}"
>
	<!-- The level colour: the thing a long timeline is scanned by. -->
	<span class="absolute inset-y-0 left-0 w-1.5 {level.bar}" aria-hidden="true"></span>

	<Avatar name={poster} />

	<div class="flex min-w-0 flex-1 flex-col gap-2">
		<header class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
			<span class="font-medium text-content">{poster}</span>
			<span class="rounded px-1.5 py-0.5 text-xs font-medium {level.badge}">{level.label}</span>
			<time
				class="ml-auto text-xs text-content-muted"
				datetime={new Date(update.createdAt).toISOString()}
			>
				{timeLabel(update.createdAt)}
			</time>
		</header>

		{#if update.title}
			<h3 class="text-base font-semibold tracking-tight text-content">{update.title}</h3>
		{/if}

		<Markdown body={update.body} />

		<!--
			Media region (design §7). Deliberately present and empty: the media
			slice renders a grid and a lightbox into it, and `media.ready` swaps a
			placeholder for the real asset live, so the seam exists before the
			feature does.
		-->
		<div data-media-region class="contents">{@render media?.(update)}</div>
	</div>
</article>
