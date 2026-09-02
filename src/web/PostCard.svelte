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
	import Thread from './Thread.svelte';
	import { absoluteLabel, relativeLabel } from './days';
	import { clock } from './clock.svelte';
	import { onMount } from 'svelte';
	import type { AckView, MessageView } from './types';

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
		/** Post a reply under this post. Resolves when the server has it. */
		onreply,
		/** Whether the card animates in, as arrivals do elsewhere (design §7). */
		isNew = false
	}: {
		post: MessageView;
		replies?: MessageView[];
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		postAcks?: AckView[];
		onlineIds?: string[];
		onreply: (body: string) => Promise<void>;
		isNew?: boolean;
	} = $props();

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
	</p>

	<!--
		Markdown, through the same renderer as everything else: raw HTML disabled
		(design §8). The owner is trusted, but the renderer is one thing rather
		than two, and a second one with the guard off would be the one that
		eventually rendered something an agent wrote.
	-->
	<Markdown body={post.body} />

	<!--
		Directly under the post, above the replies: "scout is thinking…" against
		what the owner said is the answer to "has anybody picked this up", and it
		has to be readable before the thread is.
	-->
	<Ack acks={postAcks} {agentNames} {onlineIds} />

	<Thread messages={replies} {agentNames} {acks} {onlineIds} {onreply} />
</article>
