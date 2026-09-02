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
	import Thread from './Thread.svelte';
	import UpdateActions from './UpdateActions.svelte';
	import type { OwnerActions } from './actions';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { absoluteLabel, relativeLabel } from './days';
	import { clock } from './clock.svelte';
	import { levelStyle } from './levels';
	import type { AckView, MediaView, MessageView, UpdateView } from './types';

	let {
		update,
		/**
		 * What to call the task this update is filed against, when it has one.
		 *
		 * Handed in rather than looked up: a card renders from the row it was given
		 * and nothing else, and fifty cards resolving task titles would be fifty
		 * lookups for a chip.
		 */
		taskTitle,
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
		 * The owner's write calls (design §7). Given one, the card grows a pin, a
		 * delete and a reply box; without one it renders exactly as it always has,
		 * which is what keeps every existing card spec honest.
		 */
		actions,
		/**
		 * This card's thread, oldest first (design §7).
		 *
		 * Handed down rather than fetched, because the page reads every thread in
		 * one request: fifty cards asking individually would be fifty requests to
		 * discover that most of them have no replies (`threads.svelte.ts`).
		 */
		messages = [],
		/**
		 * Agent id to display name, for the *other* speakers in the thread.
		 *
		 * `agentName` names this card's poster; a thread can hold replies from any
		 * agent, and an unnamed one would print as a ULID.
		 */
		agentNames = {},
		/**
		 * What agents have said about each message in this thread, by message id
		 * (migration 013). Handed down with the thread it annotates.
		 */
		acks = {},
		/** Ids of the agents beating right now, so a stale "thinking" is not shown. */
		onlineIds = [],
		/** The images on each message in this thread, by message id (migration 016). */
		messageMedia = {}
	}: {
		update: UpdateView;
		taskTitle?: string;
		agentName?: string;
		isNew?: boolean;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
		messages?: MessageView[];
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		onlineIds?: string[];
		messageMedia?: Record<string, MediaView[]>;
	} = $props();

	/**
	 * The page's one ticking clock (design §7).
	 *
	 * Held for as long as this card is mounted so "4m ago" stops being a lie a
	 * minute after it is rendered, and released with the card — fifty cards share
	 * one timer rather than holding fifty.
	 */
	const ticking = clock();
	onMount(() => ticking.hold());

	const level = $derived(levelStyle(update.level));
	const poster = $derived(agentLabel(update.agentId, agentName));

	/**
	 * Posting the reply is the action client's job, not the card's: the write
	 * publishes `message.created`, the tab hears it on the stream and the thread
	 * refetches, so the reply arrives here the same way it arrives in a tab that
	 * was only watching (design §4).
	 */
	async function reply(body: string, mediaIds: string[] = []): Promise<void> {
		await actions?.postMessage({
			update: update.id,
			body,
			...(mediaIds.length > 0 ? { mediaIds } : {})
		});
	}
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
			{#if update.priority === 'high'}
				<!--
					Only high is stated. `medium` is every card and would be noise;
					`low` is the agent saying "do not look at this now", which a badge
					insisting on attention would contradict.
				-->
				<span
					class="rounded bg-rose-500/15 px-1.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-300"
					data-testid="update-priority"
				>
					High
				</span>
			{/if}
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
			{#if update.editedAt}
				<!--
					Stated, not silent. An owner who read this card earlier has to be able
					to tell that what it says now is not what it said then — a timeline
					that rewrites itself quietly is one nobody can rely on (design §3).
				-->
				<span
					class="text-xs text-content-muted italic"
					data-testid="update-edited"
					title="Edited {absoluteLabel(update.editedAt)}"
				>
					edited
				</span>
			{/if}
			<!--
				How long ago, not what o'clock. A timeline is read as "what is
				happening", and `14:02` makes the reader do that arithmetic themselves.
				The exact instant is still here — in the `title` for a hover and in
				`datetime` for anything reading the markup — so nothing is lost by
				saying the useful thing first.
			-->
			<time
				class="ml-auto text-xs whitespace-nowrap text-content-muted"
				datetime={new Date(update.createdAt).toISOString()}
				title={absoluteLabel(update.createdAt)}
				data-testid="update-time"
			>
				{relativeLabel(update.createdAt, ticking.now)}
			</time>
			{#if actions}
				<UpdateActions {update} {actions} />
			{/if}
		</header>

		{#if update.title}
			<h3 class="text-base font-semibold tracking-tight text-content">{update.title}</h3>
		{/if}

		<Markdown body={update.body} />

		{#if update.taskId}
			<!--
				The card says what long-running work it is part of, and goes there. A
				feed entry on its own is "what happened"; the task is "what is being
				worked on", and one is only useful next to the other (design §7).
			-->
			<a
				href={resolve('/tasks/[id]', { id: update.taskId })}
				data-testid="update-task"
				class="flex w-fit items-center gap-1.5 rounded border border-border-subtle bg-surface px-2 py-1 text-xs text-content-muted hover:text-content"
			>
				<svg class="size-3 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h8v2H2z" />
				</svg>
				{taskTitle ?? 'View task'}
			</a>
		{/if}

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

		<!--
			The conversation on this card (design §7). Only for the owner: the reply
			box is a write, and a card rendered without an action client has nobody
			to write as.
		-->
		{#if actions}
			<Thread
				{messages}
				{agentNames}
				{acks}
				{onlineIds}
				media={messageMedia}
				uploader={actions}
				ondelete={async (id) => {
					await actions?.deleteMessage(id);
				}}
				onreply={reply}
			/>
		{/if}
	</div>
</article>
