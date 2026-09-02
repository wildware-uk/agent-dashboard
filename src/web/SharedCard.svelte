<script lang="ts">
	/**
	 * One card, as somebody holding a share link sees it (design §7, §8).
	 *
	 * **A separate component from `UpdateCard`, on purpose.** The dashboard's card
	 * grows owner controls, a reply box and a thread as the product does, and a
	 * public page that reused it would publish each of those the day it was added.
	 * This renders a fixed, small set of fields and has nowhere for more to
	 * arrive from.
	 *
	 * **No lightbox, no actions, no navigation.** A visitor was sent one card;
	 * everything interactive here would either fail without a session or invite
	 * them somewhere they cannot go. Images link to their own address so a reader
	 * who wants a closer look has one, and that address is under the share token
	 * rather than the owner's media route.
	 */
	import Avatar from './Avatar.svelte';
	import Markdown from './Markdown.svelte';
	import { absoluteLabel, relativeLabel } from './days';
	import { levelStyle } from './levels';
	import { durationLabel, mediaLabel, posterSrc, thumbSrc, thumbSrcset, videoSrc } from './media';
	import type { SharedCardView } from './types';

	let {
		card,
		/**
		 * The share's own media prefix, e.g. `/s/<token>`.
		 *
		 * Media on a public page cannot come from `/media/:id/:variant` — that
		 * route wants the owner's session. The same bytes are served under the
		 * share, scoped to this card (`src/domain/shares.ts`).
		 */
		mediaPrefix
	}: { card: SharedCardView; mediaPrefix: string } = $props();

	// Captured once: see the `<time>` below.
	const renderedAt = Date.now();

	const level = $derived(levelStyle(card.update.level));
	const shown = $derived(card.media.filter((item) => item.status === 'ready'));
</script>

<article
	data-testid="shared-card"
	data-level={card.update.level}
	class="relative flex gap-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-4 pr-5 pl-6"
>
	<span class="absolute inset-y-0 left-0 w-1.5 {level.bar}" aria-hidden="true"></span>

	<Avatar name={card.agentName} />

	<div class="flex min-w-0 flex-1 flex-col gap-3">
		<header class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
			<span class="font-medium text-content">{card.agentName}</span>
			<span class="rounded px-1.5 py-0.5 text-xs font-medium {level.badge}">{level.label}</span>
			{#if card.projectName}
				<span class="truncate text-xs text-content-muted">{card.projectName}</span>
			{/if}
			{#if card.update.editedAt}
				<span class="text-xs text-content-muted italic">edited</span>
			{/if}
			<!--
				Read once rather than ticking: this page is one card with no stores on
				it, and a visitor who has had it open for an hour is not watching the
				timestamp. The exact instant is in the title and the datetime.
			-->
			<time
				class="ml-auto text-xs whitespace-nowrap text-content-muted"
				datetime={new Date(card.update.createdAt).toISOString()}
				title={absoluteLabel(card.update.createdAt)}
			>
				{relativeLabel(card.update.createdAt, renderedAt)}
			</time>
		</header>

		{#if card.update.title}
			<h1 class="text-lg font-semibold tracking-tight text-content">{card.update.title}</h1>
		{/if}

		<Markdown body={card.update.body} />

		{#if shown.length > 0}
			<div class="flex flex-col gap-2" data-testid="shared-media">
				{#each shown as item, index (item.id)}
					{#if item.kind === 'video'}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							controls
							preload="metadata"
							poster={posterSrc(item, mediaPrefix) ?? undefined}
							src={videoSrc(item, mediaPrefix) ?? undefined}
							class="w-full rounded-md border border-border-subtle bg-surface-sunken"
						></video>
						{#if durationLabel(item.durationMs)}
							<span class="text-xs text-content-muted tabular-nums">
								{durationLabel(item.durationMs)}
							</span>
						{/if}
					{:else}
						<!--
						A media address, not a route: it is built in one place
						(`./media.ts`) and is root-relative on purpose, which is what the
						lint rule protects against and cannot see through. `resolve` is
						wrong here for the same reason it is wrong in the lightbox — it
						answers with a path relative to the current page, and this address
						has to mean the same thing everywhere.
					-->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a href={thumbSrc(item, mediaPrefix)} target="_blank" rel="noreferrer">
							<img
								src={thumbSrc(item, mediaPrefix)}
								srcset={thumbSrcset(item, mediaPrefix)}
								sizes="(min-width: 48rem) 42rem, 100vw"
								width={item.width ?? undefined}
								height={item.height ?? undefined}
								alt={mediaLabel(item, index, shown.length)}
								class="w-full rounded-md border border-border-subtle bg-surface-sunken"
							/>
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</article>
