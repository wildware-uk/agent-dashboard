<script lang="ts">
	/**
	 * The sounds on a card, playable where they sit (migration 038).
	 *
	 * The owner: "allow agents and users to attach a number of sound files, that
	 * can be played directly in the dashboard."
	 *
	 * The browser's own `<audio controls>` rather than a player built here. That
	 * is not laziness: the native control is keyboard-operable, labelled in the
	 * reader's language, has a scrubber that behaves the way that browser's users
	 * expect, and picks up the platform's own media keys and lock-screen controls.
	 * A hand-rolled play button would be a worse version of all of that, and this
	 * dashboard would then own the bugs.
	 *
	 * `preload="metadata"` on purpose: a card carrying three voice notes must not
	 * pull three files down the moment it scrolls past. The duration beside it
	 * comes from the row rather than from the element, so it is there before
	 * anything is fetched at all.
	 *
	 * One sound at a time — starting one stops the others. A feed where two
	 * recordings play over each other is a feed nobody can listen to, and the
	 * browser will happily do it.
	 */
	import { audioSrc, durationLabel, mediaLabel } from './media';
	import type { MediaView } from './types';

	let {
		items = [],
		/**
		 * Prefix for the media address, for a share page serving from `/s/:token`.
		 * Empty on the dashboard itself.
		 */
		prefix = ''
	}: { items?: MediaView[]; prefix?: string } = $props();

	let root = $state<HTMLElement | null>(null);

	/** Hush everything else on this card when one starts. */
	function soloPlay(event: Event): void {
		const started = event.currentTarget;
		for (const player of root?.querySelectorAll('audio') ?? []) {
			if (player !== started) player.pause();
		}
	}
</script>

{#if items.length > 0}
	<ul bind:this={root} data-media-sounds class="flex flex-col gap-1.5">
		{#each items as item, index (item.id)}
			{@const src = audioSrc(item, prefix)}
			{@const length = durationLabel(item.durationMs ?? null)}
			<li
				data-media-sound={item.id}
				data-media-state={item.status}
				class="flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2"
			>
				<svg
					class="size-4 shrink-0 text-content-muted"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M9.5 1.6a.5.5 0 0 1 .8.4v12a.5.5 0 0 1-.8.4L5.8 11.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h2.8zM12.3 4.2a.5.5 0 0 1 .7.1 5.6 5.6 0 0 1 0 7.4.5.5 0 1 1-.8-.6 4.6 4.6 0 0 0 0-6.2.5.5 0 0 1 .1-.7"
					/>
				</svg>

				{#if item.status === 'ready' && src}
					<!--
						A media address, not a route: built in one place (`./media.ts`) and
						root-relative on purpose, so it means the same thing on `/` and on
						`/projects/x`. Same reasoning as the download rows.
					-->
					<audio
						{src}
						controls
						preload="metadata"
						onplay={soloPlay}
						aria-label={mediaLabel(item, index, items.length)}
						class="h-8 min-w-0 flex-1"
					></audio>
					{#if length}
						<span class="shrink-0 text-xs text-content-muted tabular-nums">{length}</span>
					{/if}
				{:else if item.status === 'pending'}
					<!--
						Shown rather than hidden, like a picture's placeholder: an attachment
						that quietly vanished reads as the send having missed.
					-->
					<span class="skeleton h-4 min-w-0 flex-1 rounded"></span>
					<span class="shrink-0 text-xs text-content-muted">Processing…</span>
				{:else}
					<span class="min-w-0 flex-1 text-xs text-rose-400">This sound could not be stored.</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
