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
	import { untrack, type Snippet } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { Bumps } from './bumps.svelte';
	import { FLOW_MS, motionMs } from './motion';
	import Spinner from './Spinner.svelte';
	import RequestCard from './RequestCard.svelte';
	import { Collapsed } from './collapse.svelte';
	import { FILTERS, Filtering } from './filters.svelte';
	import { ReadComments } from './unread.svelte';
	import PostCard from './PostCard.svelte';
	import UpdateCard from './UpdateCard.svelte';
	import { lastActivityAt } from './activity';
	import { groupByDay } from './days';
	import { scrollToTop, shouldOfferTop } from './scroll';
	import type { OwnerActions } from './actions';
	import type { ThreadSource } from './threads.svelte';
	import type { Timeline } from './timeline.svelte';
	import type {
		AckView,
		DeliveryView,
		ReactionView,
		EmbedView,
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
		threadRequests = {},
		/**
		 * Which cards are folded, and where that is remembered.
		 *
		 * Injectable so a component test can hand over a storage of its own rather
		 * than sharing the browser's (`collapse.svelte.ts`).
		 */
		collapsed = undefined,
		/**
		 * What the feed is showing (design §7).
		 *
		 * Injectable so a component test can hand over a storage of its own rather
		 * than sharing the browser's (`filters.svelte.ts`).
		 */
		filtering = undefined,
		/**
		 * Which comments this browser has already seen (design §7).
		 *
		 * Injectable for the same reason the other two are: a component test hands
		 * over a storage of its own (`unread.svelte.ts`).
		 */
		read = undefined
	}: {
		feed: Timeline;
		requests?: RequestView[];
		projectNames?: Record<string, string>;
		agentNames?: Record<string, string>;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
		threads?: ThreadSource;
		onlineIds?: string[];
		focus?: string | null;
		threadRequests?: Record<string, RequestView[]>;
		collapsed?: Collapsed;
		filtering?: Filtering;
		read?: ReadComments;
	} = $props();

	/**
	 * Everything a notification's id could reasonably land on, best first.
	 *
	 * The owner: "sometimes clicking a notification does not take me to the
	 * card/comment." Four things could swallow it, and they are all this one id's
	 * problem:
	 *
	 * - a filter chip that does not match the card's work state, which would drop
	 *   the card from the page entirely;
	 * - the card being folded, which hides the whole thread a reply lives in;
	 * - the id naming a *question asked inside a thread* (migration 022), which is
	 *   rendered under the message it was asked on rather than as a card;
	 * - the id naming a reply, which is nothing at the top level of the feed.
	 *
	 * So the id is resolved to a chain — itself, the message a question hangs
	 * under, and the card carrying either — and the card at the end of it is made
	 * exempt from the filter and unfolded. A notification is a promise that there
	 * is something to see; a filter chosen five minutes ago does not get to break
	 * it, and landing on the right card beats landing nowhere.
	 */
	const chain = $derived.by(() => {
		if (!focus) return [];

		const ids = [focus];
		// A question asked in a thread: the message it was asked under is where it
		// is drawn, so that message is the next best thing to scroll to.
		for (const [messageId, asked] of Object.entries(threadRequests)) {
			if (asked.some((request) => request.id === focus)) {
				ids.push(messageId);
				break;
			}
		}

		const card = cardCarrying(ids.at(-1)!) ?? cardCarrying(focus);
		if (card && !ids.includes(card)) ids.push(card);
		return ids;
	});

	/** Which card in the feed carries this id — as itself, or in its thread. */
	function cardCarrying(id: string): string | null {
		if (feed.items.some((item) => item.id === id)) return id;
		const posts = threads?.posts?.() ?? [];
		if (posts.some((post) => post.id === id)) return id;

		for (const item of feed.items) {
			if ((threads?.for(item.id) ?? []).some((message) => message.id === id)) return item.id;
		}
		for (const post of posts) {
			if ((threads?.repliesTo?.(post.id) ?? []).some((reply) => reply.id === id)) return post.id;
		}
		return null;
	}

	/** The card at the end of the chain: the one that must be on screen at all. */
	const focused = $derived(chain.length > 1 ? (chain.at(-1) ?? null) : (chain[0] ?? null));

	/** Does the feed show this card, given the filter and what is being focused? */
	function shows(card: { id: string; status?: string | null }): boolean {
		return card.id === focused || filter.keeps(card.status);
	}

	/** A folded card hides the reply a notification is pointing at. Open it. */
	$effect(() => {
		const id = focused;
		if (id && folded.has(id)) folded.set(id, false);
	});

	/** Said out loud when the target cannot be found, rather than nothing at all. */
	let missing = $state(false);

	/** The element a focus id names, whichever kind of thing it is. */
	function focusTarget(id: string): HTMLElement | null {
		const selectors = [
			`[data-update-id="${CSS.escape(id)}"]`,
			`[data-post="${CSS.escape(id)}"]`,
			// A question the owner was asked (migration 021). It was missing here,
			// so a notification about one scrolled nowhere and said nothing —
			// half of the owner's "sometimes clicking a notification does not take
			// me to the card".
			`[data-request-id="${CSS.escape(id)}"]`,
			`[data-message-id="${CSS.escape(id)}"]`
		];
		for (const selector of selectors) {
			const found = document.querySelector<HTMLElement>(selector);
			if (found) return found;
		}
		return null;
	}

	/** The first of these ids that is actually on the page. */
	function firstOnPage(ids: readonly string[]): HTMLElement | null {
		for (const id of ids) {
			const found = focusTarget(id);
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
		missing = false;
		if (!id || typeof document === 'undefined') return;

		let attempts = 0;
		let loads = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let done = false;

		const look = () => {
			if (done) return;
			// The thing itself, or — once it is clear it is not coming — whatever is
			// next along the chain. A thread that has not rendered by now is usually
			// one this page cannot show at all, and the card it belongs to is a far
			// better answer than nothing.
			const target = attempts > 10 ? firstOnPage(chain) : focusTarget(id);
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
			// Not on screen yet. The card may simply not have arrived — or it may be
			// older than the window this page loaded, which is the case that made the
			// owner say "I cannot find it anywhere": the notification was right and
			// the timeline was showing the wrong twenty cards. So reach back for
			// more, a few pages at most, rather than giving up in silence.
			if (attempts % 8 === 0 && feed.hasMore && !feed.loading && loads < 5) {
				loads += 1;
				void feed.loadOlder();
			}
			// Nothing more to reach back for and it still is not here: waiting the
			// full nine seconds only delays telling the owner the truth.
			const exhausted = !feed.hasMore && !feed.loading && attempts > 12;
			if (attempts > 60 || exhausted) {
				// Out of patience. Say so: a click that silently did nothing reads as
				// the dashboard being broken, when the honest answer is usually that
				// the card has been deleted since the notification was written.
				missing = true;
				return;
			}
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

	/**
	 * Which cards the owner has folded away (design §7).
	 *
	 * Held here rather than on each card, because a card is replaced by id
	 * whenever anything is published (design §4): a fold kept on the row would
	 * spring open every time somebody reacted to something.
	 */
	// Captured once on purpose: the store is the owner's reading state for the
	// life of the page, and a prop that changed identity would lose every fold.
	// svelte-ignore state_referenced_locally
	const folded = collapsed ?? new Collapsed();
	// svelte-ignore state_referenced_locally
	const filter = filtering ?? new Filtering();
	// svelte-ignore state_referenced_locally
	const seen = read ?? new ReadComments();

	/**
	 * Which cards have just moved (design §7). The owner: "cards flow to the top
	 * when they are updated." The sliding is the FLIP animation on the rows
	 * below; this is the mark left behind, for a reader who was looking elsewhere
	 * and for the jump between two day groups that FLIP cannot follow.
	 */
	const bumps = new Bumps();

	/** The comments under one card, whichever kind of card it is. */
	function commentsOn(kind: 'update' | 'post' | 'request', id: string) {
		if (kind === 'post') return threads?.repliesTo?.(id) ?? [];
		if (kind === 'request') return threads?.forRequest?.(id) ?? [];
		return threads?.for(id) ?? [];
	}

	/**
	 * A card this browser has never met starts level, not unread.
	 *
	 * Without this, opening the dashboard on a new machine would badge every card
	 * in the feed with its whole history, and a badge that is on everything says
	 * nothing. The mark is written the first time a card is seen *in the data* —
	 * `untrack` because seeding writes the marks this effect would otherwise be
	 * watching, and the point is to run it once per new card, not to chase itself.
	 */
	/** Tell the bump store where every card on the page is up to. */
	$effect(() => {
		const rows = [
			...pinned.map((row) => ({ id: row.id, at: row.createdAt })),
			...groups.flatMap((group) => group.items.map((row) => ({ id: row.id, at: row.createdAt })))
		];
		untrack(() => {
			for (const row of rows) bumps.note(row.id, row.at);
		});
	});

	$effect(() => {
		const updates = feed.items.map((item) => item.id);
		const posts = (threads?.posts?.() ?? []).map((post) => post.id);
		const asked = requests.map((request) => request.id);
		untrack(() => {
			for (const id of updates) seen.seed(id, commentsOn('update', id));
			for (const id of posts) seen.seed(id, commentsOn('post', id));
			for (const id of asked) seen.seed(id, commentsOn('request', id));
		});
	});

	// Captured once. Re-reading the clock on every render would let a card slide
	// from "Today" to "Yesterday" mid-session, remounting the whole group.
	const renderedAt = Date.now();

	/**
	 * Pinned cards sort first (design §7), lifted clear of the day groups rather
	 * than reordered inside them.
	 *
	 * Sorting within a day would put a pinned card from three weeks ago at the top
	 * of *its* day and nowhere near the top of the feed, which is not what pinning
	 * it meant. So the pinned ones become their own section above everything, and
	 * the day groups render what is left — every card appears exactly once either
	 * way.
	 *
	 * Any kind of card, since migration 034 (the owner: "let me pin my own
	 * messages"). Both lists are rows of the same shape, so one section renders
	 * them through the same snippet the day groups use — the pinned section is
	 * not a second way to draw a card.
	 */
	const pinned = $derived.by(() => {
		const rows: FeedRow[] = [
			...feed.items
				.filter((item) => item.pinned && shows(item))
				.map((update) => ({
					kind: 'update' as const,
					id: update.id,
					createdAt: update.createdAt,
					update
				})),
			...(threads?.posts?.() ?? [])
				.filter((post) => post.pinned && shows(post))
				.map((post) => ({ kind: 'post' as const, id: post.id, createdAt: post.createdAt, post }))
		];

		// Newest first, as every other section is.
		return rows.sort((left, right) => right.createdAt - left.createdAt);
	});

	/**
	 * One row of the timeline: a card an agent posted, or one the owner did.
	 *
	 * The two are interleaved by time rather than kept in separate sections,
	 * because they are one conversation: "have a look at this" and the update
	 * that answers it belong next to each other, and a section of owner posts
	 * above the feed would be a second timeline to read.
	 */
	/**
	 * `createdAt` on a row is **when the card last had something happen**, not
	 * when it was posted (`./activity.ts`).
	 *
	 * The owner asked for a comment to move a post to the top, and that is what
	 * this field is: the ordering *and* the day heading both read it, because they
	 * have to agree. The card itself still shows its own age, which is what makes
	 * "3d ago" under a Today heading readable rather than wrong — it was posted
	 * three days ago and answered this morning, and the thread underneath says so.
	 */
	type FeedRow =
		| { kind: 'update'; id: string; createdAt: number; update: UpdateView }
		| { kind: 'post'; id: string; createdAt: number; post: MessageView };

	const groups = $derived.by(() => {
		const rows: FeedRow[] = [
			...feed.items
				.filter((item) => !item.pinned && shows(item))
				.map((update) => ({
					kind: 'update' as const,
					id: update.id,
					createdAt: lastActivityAt(
						update.createdAt,
						threads?.for(update.id) ?? [],
						update.statusAt
					),
					update
				})),
			...(threads?.posts?.() ?? [])
				// A pinned post is already at the top, which was the point of pinning
				// it — the same rule a pinned update keeps.
				.filter((post) => !post.pinned && shows(post))
				.map((post) => ({
					kind: 'post' as const,
					id: post.id,
					createdAt: lastActivityAt(
						post.createdAt,
						threads?.repliesTo?.(post.id) ?? [],
						post.statusAt
					),
					post
				}))
		];

		// Newest activity first. The two lists arrive sorted differently — updates
		// newest first, messages oldest first — so the merge sorts rather than
		// assuming either, and it sorts on activity rather than on age.
		rows.sort((left, right) => right.createdAt - left.createdAt);
		return groupByDay(rows, renderedAt);
	});

	/** How many cards the filter left on the page, across every section. */
	const shown = $derived(
		pinned.length + groups.reduce((total, group) => total + group.items.length, 0)
	);

	/**
	 * One key of a request's discussion, keyed by message id (migration 032).
	 *
	 * The four maps a thread needs are the same shape, and a question's
	 * discussion needs all of them for the same reasons a card's thread does — so
	 * this is written once rather than four times over.
	 */
	function keyed<T>(requestId: string, pick: (messageId: string) => T[]): Record<string, T[]> {
		const map: Record<string, T[]> = {};
		for (const message of threads?.forRequest?.(requestId) ?? []) {
			const found = pick(message.id);
			if (found.length > 0) map[message.id] = found;
		}
		return map;
	}

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

	/** The embeds on one card's thread, keyed by message id (migration 027). */
	function embedsForThread(updateId: string): Record<string, EmbedView[]> {
		const map: Record<string, EmbedView[]> = {};
		for (const message of threads?.for(updateId) ?? []) {
			const shown = threads?.embedsFor?.(message.id) ?? [];
			if (shown.length > 0) map[message.id] = shown;
		}
		return map;
	}

	/** The same, for the replies under one post. */
	function embedsForPost(postId: string): Record<string, EmbedView[]> {
		const map: Record<string, EmbedView[]> = {};
		for (const reply of threads?.repliesTo?.(postId) ?? []) {
			const shown = threads?.embedsFor?.(reply.id) ?? [];
			if (shown.length > 0) map[reply.id] = shown;
		}
		return map;
	}

	/** The emoji on each message in one card's thread (migration 024). */
	function reactionsForThread(updateId: string): Record<string, ReactionView[]> {
		const map: Record<string, ReactionView[]> = {};
		for (const message of threads?.for(updateId) ?? []) {
			const emoji = threads?.reactionsFor?.(message.id) ?? [];
			if (emoji.length > 0) map[message.id] = emoji;
		}
		return map;
	}

	/** The same, for the replies under one post. */
	function reactionsForPost(postId: string): Record<string, ReactionView[]> {
		const map: Record<string, ReactionView[]> = {};
		for (const reply of threads?.repliesTo?.(postId) ?? []) {
			const emoji = threads?.reactionsFor?.(reply.id) ?? [];
			if (emoji.length > 0) map[reply.id] = emoji;
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

	/**
	 * Whether the reader is far enough down to be offered the way back
	 * (`./scroll.ts`).
	 *
	 * Kept here beside the pill's own state because both are answers to the same
	 * `scroll` event, and reading the element twice per frame in two places is
	 * how those two would eventually disagree.
	 */
	let farDown = $state(false);

	function onscroll() {
		if (!viewport) return;
		feed.hold(viewport.scrollTop > AT_TOP_PX);
		farDown = shouldOfferTop(viewport.scrollTop, viewport.clientHeight);
	}

	/** The floating button's job, and the pill's second half. */
	function toTop() {
		scrollToTop(viewport);
	}

	/**
	 * Note what is deliberately *not* here: the connection status. It lives in the
	 * shell header, outside this scroll container, because anything that can
	 * appear above the cards moves the timeline under a reader who is scrolled
	 * into it — which is the one thing this component exists to prevent.
	 */
	function showNew() {
		feed.flush();
		toTop();
	}
</script>

<!--
	One row of the feed, wherever it appears (migration 034).
	
	Pinned cards and the day groups render the same thing through this, rather
	than each keeping their own copy of how a card is built: the pinned section
	used to draw updates only, which is why a pinned post had nowhere to go.
-->
{#snippet card(row: FeedRow)}
	{#if row.kind === 'post'}
		<!--
			`actions` as well as `uploader`, and the difference was a bug the owner
			found: the card was handed somewhere to upload images and nothing to
			write with, so a post had no reaction control, its replies had none
			either, and a question asked in its thread could not be answered. On a
			project whose feed is mostly posts, that reads as "I cannot react to
			anything here".
		-->
		<PostCard
			tags={feed.tags}
			cardTags={feed.cardTags}
			cardFields={feed.cardFields}
			cardApps={feed.cardApps}
			bumped={bumps.has(row.post.id)}
			collapsed={folded.has(row.post.id)}
			oncollapse={(fold) => folded.set(row.post.id, fold)}
			post={row.post}
			replies={threads?.repliesTo?.(row.post.id) ?? []}
			unread={seen.unread(row.post.id, commentsOn('post', row.post.id))}
			onseen={() => seen.markRead(row.post.id, commentsOn('post', row.post.id))}
			{agentNames}
			acks={acksForPost(row.post.id)}
			postAcks={threads?.acksFor?.(row.post.id) ?? []}
			postMedia={threads?.mediaFor?.(row.post.id) ?? []}
			replyMedia={mediaForPost(row.post.id)}
			postEmbeds={threads?.embedsFor?.(row.post.id) ?? []}
			replyEmbeds={embedsForPost(row.post.id)}
			postDeliveries={threads?.deliveriesFor?.(row.post.id) ?? []}
			postReactions={threads?.reactionsFor?.(row.post.id) ?? []}
			replyReactions={reactionsForPost(row.post.id)}
			replyDeliveries={deliveriesForPost(row.post.id)}
			{threadRequests}
			uploader={actions}
			{actions}
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
			tags={feed.tags}
			cardTags={feed.cardTags}
			cardFields={feed.cardFields}
			cardApps={feed.cardApps}
			bumped={bumps.has(row.update.id)}
			collapsed={folded.has(row.update.id)}
			oncollapse={(fold) => folded.set(row.update.id, fold)}
			update={row.update}
			agentName={agentNames[row.update.agentId]}
			isNew={feed.isNew(row.update.id)}
			{media}
			{actions}
			{agentNames}
			messages={threads?.for(row.update.id)}
			acks={acksFor(row.update.id)}
			messageMedia={mediaForThread(row.update.id)}
			messageEmbeds={embedsForThread(row.update.id)}
			messageDeliveries={deliveriesForThread(row.update.id)}
			{threadRequests}
			messageReactions={reactionsForThread(row.update.id)}
			reactions={row.update.reactions ?? []}
			unread={seen.unread(row.update.id, commentsOn('update', row.update.id))}
			onseen={() => seen.markRead(row.update.id, commentsOn('update', row.update.id))}
			{onlineIds}
		/>
	{/if}
{/snippet}

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
					data-testid="new-updates"
					onclick={showNew}
					class="update-enter pointer-events-auto rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-surface shadow-lg"
				>
					{feed.pendingCount} new {feed.pendingCount === 1 ? 'update' : 'updates'}
				</button>
			{/if}
		</div>
	</div>

	<div class="feed-column flex flex-col gap-6 px-3 py-4 sm:px-4">
		<!--
			What the feed is showing (design §7). The owner: "add filtering on
			dashboards, filter cards by work status, etc."

			A row of chips rather than a select: there are six, the choice is made
			with one tap, and which one is on is readable without opening anything.
			It filters the cards on the page — see `filters.svelte.ts` for why that
			is the line, and what it costs.
		-->
		{#if missing}
			<!--
				A notification that pointed at something no longer here. Said plainly
				and once, above the feed, because the alternative is a click that
				appears to do nothing at all.
			-->
			<p
				role="status"
				data-testid="focus-missing"
				class="rounded border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-content-muted"
			>
				Could not find what that notification pointed at. It may have been deleted.
			</p>
		{/if}

		<div
			role="group"
			aria-label="Filter the feed"
			data-testid="feed-filters"
			class="-mb-2 flex flex-wrap items-center gap-1.5"
		>
			{#each FILTERS as option (option.id)}
				<button
					type="button"
					aria-pressed={filter.current === option.id}
					data-filter={option.id}
					onclick={() => filter.set(option.id)}
					class="rounded-full border px-2.5 py-1 text-xs transition-colors {filter.current ===
					option.id
						? 'border-accent bg-accent/10 font-medium text-content'
						: 'border-border-subtle text-content-muted hover:text-content'}"
				>
					{option.label}
				</button>
			{/each}
			{#if filter.current !== 'all' && shown === 0}
				<span class="text-xs text-content-muted" data-testid="filter-empty">
					Nothing on this page matches. Older cards may — scroll down to load more.
				</span>
			{/if}
		</div>

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
						tags={feed.tags}
						cardTags={feed.cardTags}
						cardFields={feed.cardFields}
						cardApps={feed.cardApps}
						collapsed={folded.has(request.id)}
						oncollapse={(fold) => folded.set(request.id, fold)}
						agentName={agentNames[request.agentId]}
						projectName={request.projectId ? (projectNames[request.projectId] ?? null) : null}
						messages={threads?.forRequest?.(request.id) ?? []}
						unread={seen.unread(request.id, commentsOn('request', request.id))}
						onseen={() => seen.markRead(request.id, commentsOn('request', request.id))}
						{agentNames}
						{onlineIds}
						acks={keyed(request.id, (id) => threads?.acksFor?.(id) ?? [])}
						messageMedia={keyed(request.id, (id) => threads?.mediaFor?.(id) ?? [])}
						messageEmbeds={keyed(request.id, (id) => threads?.embedsFor?.(id) ?? [])}
						messageDeliveries={keyed(request.id, (id) => threads?.deliveriesFor?.(id) ?? [])}
						messageReactions={keyed(request.id, (id) => threads?.reactionsFor?.(id) ?? [])}
						reactions={request.reactions ?? []}
					/>
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
				{#each pinned as row (row.id)}
					<div animate:flip={{ duration: motionMs(FLOW_MS), easing: cubicOut }}>
						{@render card(row)}
					</div>
				{/each}
			</section>
		{/if}

		{#if groups.length === 0 && pinned.length === 0 && requests.length === 0}
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
					<!--
						Cards slide to their new place rather than jumping (design §7). The
						owner: "cards flow to the top when they are updated." FLIP measures
						where a row was and where it landed, so a card lifted by a reply
						travels there; the wrapper exists because the animation needs an
						element of its own to move, and the card itself is a snippet.
					-->
					{#each group.items as row (row.id)}
						<div animate:flip={{ duration: motionMs(FLOW_MS), easing: cubicOut }}>
							{@render card(row)}
						</div>
					{/each}
				</section>
			{/each}

			{#if feed.hasMore}
				<button
					type="button"
					onclick={() => feed.loadOlder()}
					disabled={feed.loading}
					class="mx-auto flex items-center gap-2 rounded border border-border-subtle px-3 py-1.5 text-sm text-content-muted hover:text-content disabled:opacity-50"
				>
					{#if feed.loading}<Spinner size="0.8rem" />{/if}
					{feed.loading ? 'Loading' : 'Load older updates'}
				</button>
			{/if}
		{/if}
	</div>

	<!--
		The way back to the top (design §7).

		A zero-height sticky layer at the bottom, exactly as the "new updates" pill
		is one at the top: the button can come and go without ever adding or
		removing layout, so a feed does not shift under somebody's thumb the moment
		they have scrolled far enough to earn it.

		Inside the scroller rather than fixed to the window, so on a wide screen it
		sits over the *feed* and not over the rail beside it — and so it is the same
		element on a phone, where there is no rail to avoid.

		**Last in the scroller, not first.** A `bottom` sticky is only ever pulled
		*up* out of the content below the fold; it is never pushed down past where
		it naturally sits. Put at the top, as the pill above it is, it simply
		scrolls away with the first screenful — which is exactly what it did.
	-->
	<div class="pointer-events-none sticky bottom-0 z-10 h-0">
		<div class="feed-column relative px-3 sm:px-4">
			{#if farDown}
				<button
					type="button"
					onclick={toTop}
					data-testid="to-top"
					aria-label="Scroll back to the top of the feed"
					class="update-enter pointer-events-auto absolute right-3 bottom-4 flex size-10 items-center justify-center rounded-full border border-border-subtle bg-surface-raised text-content-muted shadow-lg hover:text-content focus:outline-2 focus:outline-offset-2 focus:outline-accent sm:right-4"
				>
					<svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<path
							d="M8 2.75a.75.75 0 0 1 .53.22l4.5 4.5a.75.75 0 1 1-1.06 1.06L8.75 5.31v7.94a.75.75 0 0 1-1.5 0V5.31L4.03 8.53a.75.75 0 0 1-1.06-1.06l4.5-4.5A.75.75 0 0 1 8 2.75"
						/>
					</svg>
				</button>
			{/if}
		</div>
	</div>
</div>
