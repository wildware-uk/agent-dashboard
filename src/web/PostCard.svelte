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
	import Embeds from './Embeds.svelte';
	import MediaGrid from './MediaGrid.svelte';
	import CardActions from './CardActions.svelte';
	import StatusChip from './StatusChip.svelte';
	import Clamp from './Clamp.svelte';
	import Reactions from './Reactions.svelte';
	import Thread from './Thread.svelte';
	import { agentLabel } from './avatar';
	import { absoluteLabel, relativeLabel } from './days';
	import { lastUpdatedAt } from './activity';
	import Apps from './Apps.svelte';
	import CardFields from './CardFields.svelte';
	import TagChips from './TagChips.svelte';
	import UnreadBadge from './UnreadBadge.svelte';
	import { whenVisible } from './visible';
	import { foldsOnClick } from './headerclick';
	import { clock } from './clock.svelte';
	import { onMount } from 'svelte';
	import { repliesLabel, summaryOf } from './summary';
	import type {
		AckView,
		DeliveryView,
		EmbedView,
		MediaView,
		MessageView,
		ReactionView,
		RequestView,
		AppView,
		CardFieldView,
		CardTagView,
		TagView
	} from './types';
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
		/** Questions asked inside this thread, by message id (migration 022). */
		threadRequests = {},
		/** The emoji on this post (migration 024). */
		postReactions = [],
		/** And on each of its replies, by message id. */
		replyReactions = {},
		/** The owner's write calls, so a question in the thread can be answered. */
		actions = undefined,
		/** Post a reply under this post. Resolves when the server has it. */
		onreply,
		/** The images on this post, and on each of its replies (migration 016). */
		postMedia = [],
		replyMedia = {},
		/** The embeds on this post, and on each of its replies (migration 027). */
		postEmbeds = [],
		replyEmbeds = {},
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
		isNew = false,
		/**
		 * Folded away by the owner (design §7).
		 *
		 * A collapsed post keeps one line of what it said and hides its whole
		 * thread, which on this card is most of what is on screen.
		 */
		collapsed = false,
		oncollapse = undefined,
		/** The words the projects on this page know (migration 039). */
		tags = [],
		/** What is noted on the cards on this page (migration 040). */
		cardFields = [],
		/** The apps showing on the cards on this page (migration 041). */
		cardApps = [],
		/** Where those words are worn, across every card on this page. */
		cardTags = [],
		/** Just moved to the top, so it wears the marker for a moment (design §7). */
		bumped = false,
		/** How many replies here the reader has not seen (design §7). */
		unread = 0,
		/** Called once the post has been on screen long enough to count as read. */
		onseen = undefined
	}: {
		post: MessageView;
		replies?: MessageView[];
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		postAcks?: AckView[];
		onlineIds?: string[];
		postDeliveries?: DeliveryView[];
		replyDeliveries?: Record<string, DeliveryView[]>;
		threadRequests?: Record<string, RequestView[]>;
		postReactions?: ReactionView[];
		replyReactions?: Record<string, ReactionView[]>;
		actions?: OwnerActions;
		onreply: (body: string, mediaIds?: string[], answers?: string) => Promise<void>;
		postMedia?: MediaView[];
		replyMedia?: Record<string, MediaView[]>;
		postEmbeds?: EmbedView[];
		replyEmbeds?: Record<string, EmbedView[]>;
		uploader?: Pick<OwnerActions, 'uploadMedia'>;
		ondelete?: (id: string) => Promise<void>;
		ondeletepost?: () => Promise<void>;
		isNew?: boolean;
		collapsed?: boolean;
		oncollapse?: (collapsed: boolean) => void;
		tags?: TagView[];
		cardFields?: CardFieldView[];
		cardApps?: AppView[];
		cardTags?: CardTagView[];
		bumped?: boolean;
		unread?: number;
		onseen?: () => void;
	} = $props();

	/**
	 * Who wrote it.
	 *
	 * `human` is the owner, and the owner is the one reading this, so it says
	 * "You". Anything else is `agent:<agent_id>` — an agent's note filed against
	 * the project rather than against a card. Those used to render nowhere at
	 * all, which meant an agent could answer and never be heard.
	 */
	/** When this post last changed: a reply, a work state, an edit (design §7). */
	const updatedAt = $derived(lastUpdatedAt(post.createdAt, replies, post.statusAt, post.editedAt));

	const mine = $derived(post.author === 'human');
	const writer = $derived(
		mine
			? 'You'
			: agentLabel(
					post.author.startsWith('agent:') ? post.author.slice('agent:'.length) : '',
					agentNames[post.author.startsWith('agent:') ? post.author.slice('agent:'.length) : '']
				)
	);

	/** The page's one ticking clock, so "4m ago" keeps up (design §7). */
	const ticking = clock();
	onMount(() => ticking.hold());
</script>

<article
	use:whenVisible={{
		// A folded card hides its thread, so being on screen is not reading it.
		enabled: unread > 0 && onseen !== undefined && !collapsed,
		onvisible: () => onseen?.()
	}}
	data-bumped={bumped ? 'true' : undefined}
	data-post={post.id}
	data-mine={mine ? 'true' : undefined}
	class="group flex min-w-0 flex-col gap-2 rounded-lg border border-l-3 border-border-subtle bg-surface-raised p-3 {mine
		? 'border-l-accent'
		: 'border-l-border-subtle'} {isNew ? 'update-enter' : ''}"
>
	<!--
		Folding by clicking the header (design §7). The owner: "clicking on any
		empty part (or the title) of the header of a card should collapse and
		expand it." `headerclick.ts` decides what counts as empty — the work
		chip, the pin and the chevron all still do their own job, and a click
		that was really a text selection is left alone.

		The chevron in {@link CardActions} stays the labelled, focusable control,
		which is why this handler has no keyboard half: a header that is itself a
		tab stop, full of buttons that are tab stops, is worse to move through
		than one that is not.
	-->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<p
		class="flex flex-wrap items-baseline gap-x-2 text-xs {oncollapse ? 'cursor-pointer' : ''}"
		onclick={(event: MouseEvent) => {
			if (oncollapse && foldsOnClick(event)) oncollapse(!collapsed);
		}}
	>
		<!--
			"You" for the owner — there is one, and they are the one reading this, so
			a name would be a label nobody set repeated on every card. An agent gets
			its name, and the accent rail stays the owner's alone: "mine" means one
			thing everywhere on the page.
		-->
		<span class="font-medium text-content">{writer}</span>
		<span class="text-content-muted">posted</span>
		<UnreadBadge count={unread} />
		<time
			class="ml-auto text-content-muted"
			datetime={new Date(updatedAt).toISOString()}
			title={updatedAt > post.createdAt
				? `Posted ${absoluteLabel(post.createdAt)} · updated ${absoluteLabel(updatedAt)}`
				: absoluteLabel(post.createdAt)}
			data-testid="post-time"
			data-updated={updatedAt > post.createdAt ? 'true' : undefined}
		>
			{updatedAt > post.createdAt ? 'updated ' : ''}{relativeLabel(updatedAt, ticking.now)}
		</time>
		<!-- Where the work has got to, if it is work (migration 035). -->
		<StatusChip
			status={post.status}
			onstatus={actions
				? async (status) => {
						await actions.setCardStatus('message', post.id, status);
					}
				: undefined}
		/>
		{#if actions}
			<!--
				The same controls every card has (migration 034). The owner asked to
				pin their own posts; the delete that was written here by hand is the
				one {@link CardActions} does, confirmation and all.
			-->
			<CardActions
				noun="post"
				{collapsed}
				{oncollapse}
				pinned={post.pinned ?? false}
				onpin={(pinned) => actions.pinCard('message', post.id, pinned)}
				ondelete={ondeletepost}
				deleteWarning={`Delete this post${
					replies.length > 0
						? ` and ${replies.length === 1 ? 'its reply' : `its ${replies.length} replies`}`
						: ''
				}?`}
			/>
		{/if}
	</p>

	<!-- The project's own words (migration 039), under the owner's own line. -->
	<TagChips
		card={{ kind: 'message', id: post.id }}
		projectId={post.projectId}
		{tags}
		worn={cardTags}
		ontag={actions ? (tagId, on) => actions.tagCard('message', post.id, tagId, on) : undefined}
		oncreate={actions
			? async (name, colour) => {
					const made = await actions.defineTag(post.projectId ?? '', name, colour);
					await actions.tagCard('message', post.id, made.id, true);
				}
			: undefined}
		onrecolour={actions
			? async (tagId, colour) => {
					await actions.renameTag(tagId, { colour });
				}
			: undefined}
	/>

	{#if collapsed}
		<!--
			One line of what it said, and how much is hidden (design §7). On a post
			the thread is usually most of the card, which is what makes folding it
			worth a control.
		-->
		<p class="min-w-0 truncate text-sm text-content-muted" data-testid="card-summary">
			{summaryOf(post.body) || 'No words on this post.'}
		</p>
		{#if replies.length > 0}
			<p class="text-xs text-content-muted" data-testid="card-hidden">
				{repliesLabel(replies.length)} hidden
			</p>
		{/if}
	{:else}
		<!--
			Markdown, through the same renderer as everything else: raw HTML disabled
			(design §8). The owner is trusted, but the renderer is one thing rather
			than two, and a second one with the guard off would be the one that
			eventually rendered something an agent wrote.

			Shortened when it runs long, as every other card's body is.
		-->
		<Clamp noun="the whole post">
			<Markdown body={post.body} />
		</Clamp>

		{#if postMedia.length > 0}
			<MediaGrid items={postMedia} />
		{/if}

		<!-- Anything the post is portraying, in its source's style (migration 027). -->
		<Embeds items={postEmbeds} />

		<!--
			Directly under the post, above the replies: "scout is thinking…" against
			what the owner said is the answer to "has anybody picked this up", and it
			has to be readable before the thread is.
		-->
		<Ack
			acks={postAcks}
			deliveries={postDeliveries}
			{agentNames}
			{onlineIds}
			now={ticking.now}
			expects={mine && !post.status ? { createdAt: post.createdAt } : undefined}
		/>

		<!--
			The apps on this card (migration 041): interactive UI an agent shipped,
			run in a sandboxed frame. Collapsed until it is asked for — an app is
			somebody else's code, and scrolling past a card is not asking to run it.
		-->
		<Apps card={{ kind: 'message', id: post.id }} apps={cardApps} {actions} />

		<!-- What is known about this post (migration 040), behind one line. -->
		<CardFields
			card={{ kind: 'message', id: post.id }}
			fields={cardFields}
			onset={actions
				? (name, value) => actions.setCardField('message', post.id, name, value)
				: undefined}
		/>

		<!-- The emoji on the post itself (migration 024). -->
		<Reactions
			reactions={postReactions}
			{agentNames}
			onreact={actions
				? async (emoji) => {
						await actions.react(post.id, emoji);
					}
				: undefined}
		/>

		<Thread
			messages={replies}
			{agentNames}
			{acks}
			{onlineIds}
			media={replyMedia}
			embeds={replyEmbeds}
			{cardApps}
			deliveries={replyDeliveries}
			requests={threadRequests}
			reactions={replyReactions}
			{actions}
			{uploader}
			{ondelete}
			{onreply}
		/>
	{/if}
</article>
