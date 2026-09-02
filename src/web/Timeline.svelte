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
	import RequestCard from './RequestCard.svelte';
	import PostCard from './PostCard.svelte';
	import UpdateCard from './UpdateCard.svelte';
	import { groupByDay } from './days';
	import type { OwnerActions } from './actions';
	import type { ThreadSource } from './threads.svelte';
	import type { Timeline } from './timeline.svelte';
	import { resolve } from '$app/paths';
	import type {
		AckView,
		DeliveryView,
		MediaView,
		MessageView,
		RequestView,
		UpdateView
	} from './types';

	let {
		feed,
		/**
		 * What agents are blocked on, already scoped to this feed by the shell
		 * (design §5, §7).
		 *
		 * Handed in rather than read from a store, for the same reason the cards
		 * are: this component renders what it is given. The shell owns the queue
		 * because the queue is not the timeline's — a request belongs to the owner,
		 * and which of them belong on *this* feed is the shell's question.
		 */
		requests = [],
		/**
		 * Project id to name, for the request cards.
		 *
		 * Supplied only when the feed spans every project: on a project page the
		 * name would be on every card, saying nothing. So an empty map here is not
		 * missing data, it is the shell saying "they are all this project's".
		 */
		projectNames = {},
		/**
		 * Agent id to display name, resolved by the shell from the timeline
		 * snapshot and from presence. A card with no entry here names its poster
		 * from the id instead, readably (see `agentLabel`).
		 */
		agentNames = {},
		/** Task id to title, for the chip a card grows when it is progress on one. */
		taskTitles = {},
		/** Passed through to each card's media region. */
		media,
		/** The owner's write calls, passed to every card (design §7). */
		actions,
		/**
		 * The page's message threads, if the shell is holding them.
		 *
		 * Read here rather than in each card so the whole page costs one request:
		 * the store holds every thread and hands each card its own by id.
		 */
		threads,
		/**
		 * Ids of the agents beating right now (design §4).
		 *
		 * Passed down so a card can show an agent's "is thinking…" only while that
		 * agent is actually alive — an animation running against a session that
		 * died is a lie the owner cannot check (migration 013).
		 */
		onlineIds = [],
		/**
		 * What to scroll to and light up, from a notification (migration 021).
		 *
		 * An update id, a post id or a message id — whichever the notification
		 * pointed at. Landing at the top of a project with fifty cards under it is
		 * what the owner asked me to stop doing, so this waits for the thing to
		 * exist (a card three pages down arrives with the next read) and only then
		 * moves the viewport.
		 */
		focus = null,
		/**
		 * Questions asked inside a thread, by the message they were asked under
		 * (migration 022).
		 *
		 * They render in the conversation rather than as cards at the top of the
		 * feed: an agent that has been talking to its owner and then needs a
		 * decision should be able to ask where the talking happened.
		 */
		threadRequests = {}
	}: {
		feed: Timeline;
		requests?: RequestView[];
		projectNames?: Record<string, string>;
		agentNames?: Record<string, string>;
		taskTitles?: Record<string, string>;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
		threads?: ThreadSource;
		onlineIds?: string[];
		focus?: string | null;
		threadRequests?: Record<string, RequestView[]>;
	} = $props();

	/** The element a focus id names, whichever kind of thing it is. */
	function focusTarget(id: string): HTMLElement | null {
		const selectors = [
			`[data-update-id="${CSS.escape(id)}"]`,
			`[data-post="${CSS.escape(id)}"]`,
			`[data-message-id="${CSS.escape(id)}"]`
		];
		for (const selector of selectors) {
			const found = document.querySelector<HTMLElement>(selector);
			if (found) return found;
		}
		return null;
	}

	/**
	 * Scroll a notification's target into view and mark it, once it exists.
	 *
	 * The card may not be rendered yet — the page loads a window of the timeline
	 * and the thread arrives in its own request — so this retries briefly rather
	 * than giving up on the first miss, and then stops rather than spinning: a
	 * notification about something that has since been deleted must not leave a
	 * loop running behind a page nobody is looking at.
	 */
	$effect(() => {
		const id = focus;
		if (!id || typeof document === 'undefined') return;

		let attempts = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let done = false;

		const look = () => {
			if (done) return;
			const target = focusTarget(id);
			if (target) {
				done = true;
				target.scrollIntoView({ block: 'center', behavior: 'smooth' });
				// A ring rather than a permanent state: it says "this one", and then
				// gets out of the way of reading it.
				target.setAttribute('data-focused', 'true');
				timer = setTimeout(() => target.removeAttribute('data-focused'), 4_000);
				return;
			}
			attempts += 1;
			if (attempts > 20) return;
			timer = setTimeout(look, 150);
		};

		look();
		return () => {
			done = true;
			if (timer !== undefined) clearTimeout(timer);
		};
	});

	/**
	 * The acknowledgements on one card's thread, keyed by message id.
	 *
	 * Built here rather than in the card because the store is the shell's: a card
	 * that reached for it would need one, which is what keeps every card spec
	 * renderable with two messages and no server.
	 */
	function acksFor(updateId: string): Record<string, AckView[]> {
		const map: Record<string, AckView[]> = {};
		for (const message of threads?.for(updateId) ?? []) {
			const said = threads?.acksFor?.(message.id) ?? [];
			if (said.length > 0) map[message.id] = said;
		}
		return map;
	}

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

	/**
	 * How many replied-to cards ride at the top before the rest stay where they
	 * are.
	 *
	 * A cap rather than "every card with a reply", because on a board that has
	 * been running a while that is most of them, and a section containing most of
	 * the feed is not a section. Five is what fits above the fold next to the
	 * pinned ones.
	 */
	const REPLIED_LIMIT = 5;

	/**
	 * Cards with a conversation on them, newest reply first (design §7).
	 *
	 * Lifted clear of the day groups for exactly the reason pinned updates are:
	 * a card whose reply landed a minute ago belongs at the top of the *feed*, and
	 * reordering it inside its own day would put it at the top of "Tuesday" and
	 * nowhere near the top of anything the reader is looking at. Its `created_at`
	 * is untouched, so it keeps its place in the day groups' history the moment it
	 * stops being one of the most recently replied to.
	 *
	 * Pinned cards are excluded rather than appearing twice: they are already at
	 * the top, which was the point of pinning them.
	 */
	const replied = $derived.by(() => {
		if (!threads) return [];

		const withReplies = feed.items
			.filter((item) => !item.pinned)
			.map((item) => {
				const thread = threads.for(item.id);
				const newest = thread.at(-1);
				return {
					item,
					// Only conversations that are *the owner's* ride the top
					// (#feedback: "Recent replies should only show replies to me, not to
					// other agents"). A card is here because somebody answered them, so
					// it takes both halves: they spoke in the thread, and the newest
					// thing in it came back from an agent. One agent leaving a note on
					// another's card is a comment, and it belongs in its day.
					at:
						newest && newest.author !== 'human' && thread.some((m) => m.author === 'human')
							? newest.createdAt
							: null
				};
			})
			.filter((candidate): candidate is { item: UpdateView; at: number } => candidate.at !== null)
			// Read conversations drop back into their day (migration 015). Without
			// this the section only ever grew, and the cards riding above the
			// timeline became the ones that had been ignored the longest — the exact
			// opposite of what lifting them up was for.
			.filter((candidate) => (candidate.item.repliesSeenAt ?? 0) < candidate.at);

		return withReplies
			.sort((left, right) => right.at - left.at)
			.slice(0, REPLIED_LIMIT)
			.map((candidate) => candidate.item);
	});

	/** Marking a thread read, and what went wrong if it did not take. */
	let marking = $state(false);

	async function markRead(ids: string[]): Promise<void> {
		if (!actions || ids.length === 0) return;
		marking = true;
		try {
			// One call per card rather than a bulk endpoint: "mark all" is at most
			// five of them, and a second endpoint would be a second thing to keep in
			// step with the first.
			await Promise.all(ids.map((id) => actions.markRepliesSeen(id)));
		} catch {
			// Swallowed on purpose. The card staying put is the whole failure, the
			// next click retries it, and an error banner over the feed for a
			// dismissal is louder than the thing it is reporting.
		} finally {
			marking = false;
		}
	}

	/**
	 * One row of the timeline: a card an agent posted, or one the owner did.
	 *
	 * The two are interleaved by time rather than kept in separate sections,
	 * because they are one conversation: "have a look at this" and the update
	 * that answers it belong next to each other, and a section of owner posts
	 * above the feed would be a second timeline to read.
	 */
	type FeedRow =
		| { kind: 'update'; id: string; createdAt: number; update: UpdateView }
		| { kind: 'post'; id: string; createdAt: number; post: MessageView };

	const groups = $derived.by(() => {
		const lifted = new Set(replied.map((item) => item.id));
		const rows: FeedRow[] = [
			...feed.items
				.filter((item) => !item.pinned && !lifted.has(item.id))
				.map((update) => ({
					kind: 'update' as const,
					id: update.id,
					createdAt: update.createdAt,
					update
				})),
			...(threads?.posts?.() ?? []).map((post) => ({
				kind: 'post' as const,
				id: post.id,
				createdAt: post.createdAt,
				post
			}))
		];

		// Newest first, the way the server orders updates: the two lists arrive
		// sorted differently — updates newest first, messages oldest first — so the
		// merge sorts rather than assuming either.
		rows.sort((left, right) => right.createdAt - left.createdAt);
		return groupByDay(rows, renderedAt);
	});

	/** The images on one card's thread, keyed by message id (migration 016). */
	function mediaForThread(updateId: string): Record<string, MediaView[]> {
		const map: Record<string, MediaView[]> = {};
		for (const message of threads?.for(updateId) ?? []) {
			const images = threads?.mediaFor?.(message.id) ?? [];
			if (images.length > 0) map[message.id] = images;
		}
		return map;
	}

	/** The same, for the replies under one post. */
	function mediaForPost(postId: string): Record<string, MediaView[]> {
		const map: Record<string, MediaView[]> = {};
		for (const reply of threads?.repliesTo?.(postId) ?? []) {
			const images = threads?.mediaFor?.(reply.id) ?? [];
			if (images.length > 0) map[reply.id] = images;
		}
		return map;
	}

	/** Which agents each message in one card's thread has reached (migration 018). */
	function deliveriesForThread(updateId: string): Record<string, DeliveryView[]> {
		const map: Record<string, DeliveryView[]> = {};
		for (const message of threads?.for(updateId) ?? []) {
			const sent = threads?.deliveriesFor?.(message.id) ?? [];
			if (sent.length > 0) map[message.id] = sent;
		}
		return map;
	}

	/** The same, for the replies under one post. */
	function deliveriesForPost(postId: string): Record<string, DeliveryView[]> {
		const map: Record<string, DeliveryView[]> = {};
		for (const reply of threads?.repliesTo?.(postId) ?? []) {
			const sent = threads?.deliveriesFor?.(reply.id) ?? [];
			if (sent.length > 0) map[reply.id] = sent;
		}
		return map;
	}

	/** The acknowledgements on one post's replies, keyed by message id. */
	function acksForPost(postId: string): Record<string, AckView[]> {
		const map: Record<string, AckView[]> = {};
		for (const reply of threads?.repliesTo?.(postId) ?? []) {
			const said = threads?.acksFor?.(reply.id) ?? [];
			if (said.length > 0) map[reply.id] = said;
		}
		return map;
	}

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
		{#if feed.task}
			<!--
				What the feed is showing, and the way out. A filtered feed that did not
				say so would read as a timeline that had gone quiet.
			-->
			<div
				class="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-surface-raised px-3 py-2 text-sm"
				data-testid="feed-filter"
			>
				<span class="text-content-muted">Showing updates on</span>
				<span class="min-w-0 font-medium text-content">
					{taskTitles[feed.task] ?? 'one task'}
				</span>
				<a
					href={resolve('/tasks/[id]', { id: feed.task })}
					class="text-xs text-content-muted underline hover:text-content"
				>
					Open task
				</a>
				<button
					type="button"
					data-testid="clear-filter"
					onclick={() => void feed.filterByTask(null)}
					class="ml-auto rounded border border-border-subtle px-2 py-0.5 text-xs text-content-muted hover:text-content"
				>
					Show everything
				</button>
			</div>
		{/if}

		{#if requests.length > 0 && actions}
			<!--
				The top of the feed, above even the pinned updates (design §7). An
				agent that has stopped dead outranks anything the owner pinned for
				themselves, and unlike the sticky banner this used to be, it is part
				of the page rather than parked on top of it.
			-->
			<section
				class="flex flex-col gap-3"
				aria-labelledby="feed-requests"
				data-testid="request-section"
			>
				<h2
					id="feed-requests"
					class="sticky top-0 z-1 -mx-1 flex items-center gap-2 bg-surface/90 px-1 py-1 text-xs font-semibold tracking-wide text-amber-600 uppercase backdrop-blur dark:text-amber-400"
				>
					Waiting on you
					{#if requests.length > 1}
						<span class="tabular-nums" data-testid="request-count">({requests.length})</span>
					{/if}
				</h2>
				{#each requests as request (request.id)}
					<RequestCard
						{request}
						{actions}
						agentName={agentNames[request.agentId]}
						projectName={request.projectId ? (projectNames[request.projectId] ?? null) : null}
					/>
				{/each}
			</section>
		{/if}

		{#if replied.length > 0}
			<!--
				Conversations, above the day groups and below anything pinned: a reply
				is the newest thing that happened to a card, and the card it happened
				to is what the reader wants next to it.
			-->
			<section
				class="flex flex-col gap-3"
				aria-labelledby="day-replied"
				data-testid="replied-section"
			>
				<h2
					id="day-replied"
					class="sticky top-0 z-1 -mx-1 flex items-center gap-2 bg-surface/90 px-1 py-1 text-xs font-semibold tracking-wide text-content-muted uppercase backdrop-blur"
				>
					Recent replies
					{#if actions}
						<button
							type="button"
							disabled={marking}
							data-testid="mark-all-replies-read"
							onclick={() => markRead(replied.map((item) => item.id))}
							class="ml-auto rounded px-1.5 py-0.5 text-xs font-medium normal-case hover:bg-surface-raised hover:text-content disabled:opacity-50"
						>
							Mark all read
						</button>
					{/if}
				</h2>
				{#each replied as update (update.id)}
					<div class="flex min-w-0 flex-col gap-1">
						<UpdateCard
							{update}
							agentName={agentNames[update.agentId]}
							taskTitle={update.taskId ? taskTitles[update.taskId] : undefined}
							isNew={feed.isNew(update.id)}
							{media}
							{actions}
							{agentNames}
							messages={threads?.for(update.id)}
							acks={acksFor(update.id)}
							messageMedia={mediaForThread(update.id)}
							messageDeliveries={deliveriesForThread(update.id)}
							{threadRequests}
							{onlineIds}
						/>
						{#if actions}
							<!--
								Under the card rather than on it: the card is the same component
								wherever it appears, and a button that only exists in one
								section belongs to the section.
							-->
							<button
								type="button"
								disabled={marking}
								data-testid="mark-replies-read"
								aria-label="Mark the conversation on {update.title ?? 'this update'} as read"
								onclick={() => markRead([update.id])}
								class="self-end rounded px-1.5 py-0.5 text-xs text-content-muted hover:bg-surface-raised hover:text-content disabled:opacity-50"
							>
								Done with this
							</button>
						{/if}
					</div>
				{/each}
			</section>
		{/if}

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
						taskTitle={update.taskId ? taskTitles[update.taskId] : undefined}
						isNew={feed.isNew(update.id)}
						{media}
						{actions}
						{agentNames}
						messages={threads?.for(update.id)}
						acks={acksFor(update.id)}
						messageMedia={mediaForThread(update.id)}
						messageDeliveries={deliveriesForThread(update.id)}
						{threadRequests}
						{onlineIds}
					/>
				{/each}
			</section>
		{/if}

		{#if groups.length === 0 && pinned.length === 0 && requests.length === 0 && replied.length === 0}
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
					{#each group.items as row (row.id)}
						{#if row.kind === 'post'}
							<PostCard
								post={row.post}
								replies={threads?.repliesTo?.(row.post.id) ?? []}
								{agentNames}
								acks={acksForPost(row.post.id)}
								postAcks={threads?.acksFor?.(row.post.id) ?? []}
								postMedia={threads?.mediaFor?.(row.post.id) ?? []}
								replyMedia={mediaForPost(row.post.id)}
								postDeliveries={threads?.deliveriesFor?.(row.post.id) ?? []}
								replyDeliveries={deliveriesForPost(row.post.id)}
								{threadRequests}
								uploader={actions}
								{onlineIds}
								onreply={async (body, mediaIds = [], answers) => {
									// The images go with it: a reply that quietly dropped the
									// screenshot it was written about would be worse than one
									// that failed to send.
									await actions?.postMessage({
										replyTo: row.post.id,
										body,
										...(mediaIds.length > 0 ? { mediaIds } : {}),
										...(answers ? { answers } : {})
									});
								}}
								ondelete={actions
									? async (id) => {
											await actions.deleteMessage(id);
										}
									: undefined}
								ondeletepost={actions
									? async () => {
											await actions.deleteMessage(row.post.id);
										}
									: undefined}
							/>
						{:else}
							<UpdateCard
								update={row.update}
								agentName={agentNames[row.update.agentId]}
								taskTitle={row.update.taskId ? taskTitles[row.update.taskId] : undefined}
								isNew={feed.isNew(row.update.id)}
								{media}
								{actions}
								{agentNames}
								messages={threads?.for(row.update.id)}
								acks={acksFor(row.update.id)}
								messageMedia={mediaForThread(row.update.id)}
								messageDeliveries={deliveriesForThread(row.update.id)}
								{threadRequests}
								{onlineIds}
							/>
						{/if}
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
