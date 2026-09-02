<script lang="ts">
	/**
	 * One thing the owner said, as a card in the feed (migration 014).
	 *
	 * Deliberately **not** `UpdateCard`. An update is what an agent reported and
	 * the owner curates it — pin it, share it, delete it. A post is the owner's
	 * own words, and none of those verbs apply to it: there is nothing to pin
	 * above itself, nothing to share that they did not write, and no agent whose
	 * work would be erased. What it has instead is the one thing that matters:
	 * replies, so an agent can answer or ask them something back.
	 *
	 * It reads as theirs at a glance — an accent rail rather than a level colour,
	 * because a post has no level. Nothing an agent wrote is styled this way.
	 */
	import Ack from './Ack.svelte';
	import Markdown from './Markdown.svelte';
	import MediaGrid from './MediaGrid.svelte';
	import Thread from './Thread.svelte';
	import { actionMessage } from './actions';
	import { absoluteLabel, relativeLabel } from './days';
	import { clock } from './clock.svelte';
	import { onMount } from 'svelte';
	import type { AckView, DeliveryView, MediaView, MessageView } from './types';
	import type { OwnerActions } from './actions';

	let {
		/** The post itself: a message anchored to nothing. */
		post,
		/** Its replies, oldest first. */
		replies = [],
		/** Agent id to display name, for the agents answering. */
		agentNames = {},
		/** What agents have said about each reply, by message id (migration 013). */
		acks = {},
		/**
		 * What agents have said about the post itself.
		 *
		 * Separate from {@link acks}, which is keyed by reply: an agent
		 * acknowledging *this post* is answering the owner without words, and it
		 * belongs under their words rather than under somebody's reply to them.
		 */
		postAcks = [],
		/** Ids of the agents beating right now, so a stale "thinking" is not shown. */
		onlineIds = [],
		/** Which agents this post has reached (migration 018). */
		postDeliveries = [],
		/** The same for each reply, by message id. */
		replyDeliveries = {},
		/** Post a reply under this post. Resolves when the server has it. */
		onreply,
		/** The images on this post, and on each of its replies (migration 016). */
		postMedia = [],
		replyMedia = {},
		/** Somewhere to upload a reply's images, when there is a server behind the card. */
		uploader = undefined,
		/** Delete one of the replies under this post (migration 017). */
		ondelete = undefined,
		/**
		 * Delete the post itself, replies and all.
		 *
		 * Separate from {@link ondelete} because it is a different act: deleting a
		 * reply takes one line, deleting the post takes the conversation. The
		 * control says so before it fires.
		 */
		ondeletepost = undefined,
		/** Whether the card animates in, as arrivals do elsewhere (design §7). */
		isNew = false
	}: {
		post: MessageView;
		replies?: MessageView[];
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		postAcks?: AckView[];
		onlineIds?: string[];
		postDeliveries?: DeliveryView[];
		replyDeliveries?: Record<string, DeliveryView[]>;
		onreply: (body: string, mediaIds?: string[]) => Promise<void>;
		postMedia?: MediaView[];
		replyMedia?: Record<string, MediaView[]>;
		uploader?: Pick<OwnerActions, 'uploadMedia'>;
		ondelete?: (id: string) => Promise<void>;
		ondeletepost?: () => Promise<void>;
		isNew?: boolean;
	} = $props();

	/** Asking before the post and its whole thread go. */
	let confirming = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function removePost(): Promise<void> {
		if (!ondeletepost) return;
		busy = true;
		error = null;
		try {
			await ondeletepost();
			confirming = false;
		} catch (cause) {
			// The card stays as it was: nothing here is removed optimistically, so a
			// delete that failed leaves the post on screen where it belongs.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	/** The page's one ticking clock, so "4m ago" keeps up (design §7). */
	const ticking = clock();
	onMount(() => ticking.hold());
</script>

<article
	data-post={post.id}
	class="flex min-w-0 flex-col gap-2 rounded-lg border border-l-3 border-border-subtle border-l-accent bg-surface-raised p-3 {isNew
		? 'update-enter'
		: ''}"
>
	<p class="flex flex-wrap items-baseline gap-x-2 text-xs">
		<!--
			"You", not a name: there is one owner and they are the one reading this,
			so a name here would be a label nobody set repeated on every card.
		-->
		<span class="font-medium text-content">You</span>
		<span class="text-content-muted">posted</span>
		<time
			class="ml-auto text-content-muted"
			datetime={new Date(post.createdAt).toISOString()}
			title={absoluteLabel(post.createdAt)}
		>
			{relativeLabel(post.createdAt, ticking.now)}
		</time>
		{#if ondeletepost && !confirming}
			<button
				type="button"
				aria-label="Delete this post"
				onclick={() => {
					confirming = true;
					error = null;
				}}
				class="rounded p-1 text-content-muted hover:bg-surface hover:text-rose-400"
			>
				<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M6 1h4l.5 1H14v2H2V2h3.5zM3 5h10l-.8 9.2a1 1 0 0 1-1 .8H4.8a1 1 0 0 1-1-.8z" />
				</svg>
			</button>
		{/if}
	</p>

	{#if confirming}
		<div
			role="group"
			aria-label="Confirm delete"
			class="flex flex-wrap items-center gap-2 rounded border border-border-subtle bg-surface px-2 py-1.5 text-xs"
		>
			<!--
				Says what goes, because it is more than the words above: a post's
				replies have no life without it, so they go too.
			-->
			<span class="text-content">
				Delete this post{replies.length > 0
					? ` and ${replies.length === 1 ? 'its reply' : `its ${replies.length} replies`}`
					: ''}?
			</span>
			<button
				type="button"
				disabled={busy}
				onclick={removePost}
				class="rounded bg-rose-600 px-2 py-0.5 font-medium text-white disabled:opacity-50"
			>
				Confirm delete
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => {
					confirming = false;
					error = null;
				}}
				class="rounded border border-border-subtle px-2 py-0.5 text-content-muted hover:text-content"
			>
				Cancel
			</button>
		</div>
		{#if error}
			<p role="alert" class="text-xs text-rose-400">{error}</p>
		{/if}
	{/if}

	<!--
		Markdown, through the same renderer as everything else: raw HTML disabled
		(design §8). The owner is trusted, but the renderer is one thing rather
		than two, and a second one with the guard off would be the one that
		eventually rendered something an agent wrote.
	-->
	<Markdown body={post.body} />

	{#if postMedia.length > 0}
		<MediaGrid items={postMedia} />
	{/if}

	<!--
		Directly under the post, above the replies: "scout is thinking…" against
		what the owner said is the answer to "has anybody picked this up", and it
		has to be readable before the thread is.
	-->
	<Ack acks={postAcks} deliveries={postDeliveries} {agentNames} {onlineIds} />

	<Thread
		messages={replies}
		{agentNames}
		{acks}
		{onlineIds}
		media={replyMedia}
		deliveries={replyDeliveries}
		{uploader}
		{ondelete}
		{onreply}
	/>
</article>
