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
	import { repliesLabel, summaryOf } from './summary';
	import Markdown from './Markdown.svelte';
	import Embeds from './Embeds.svelte';
	import MediaGrid from './MediaGrid.svelte';
	import Clamp from './Clamp.svelte';
	import Reactions from './Reactions.svelte';
	import StatusChip from './StatusChip.svelte';
	import Thread from './Thread.svelte';
	import UpdateActions from './UpdateActions.svelte';
	import type { OwnerActions } from './actions';
	import { onMount } from 'svelte';
	import { absoluteLabel, relativeLabel } from './days';
	import { lastUpdatedAt } from './activity';
	import Apps from './Apps.svelte';
	import CardFields from './CardFields.svelte';
	import TagChips from './TagChips.svelte';
	import UnreadBadge from './UnreadBadge.svelte';
	import { whenVisible } from './visible';
	import { foldsOnClick } from './headerclick';
	import { clock } from './clock.svelte';
	import { levelStyle } from './levels';
	import type {
		AckView,
		DeliveryView,
		EmbedView,
		MediaView,
		MessageView,
		ReactionView,
		RequestView,
		UpdateView,
		AppView,
		CardFieldView,
		CardTagView,
		TagView
	} from './types';

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
		messageMedia = {},
		messageEmbeds = {},
		/** Which agents each message in this thread has reached (migration 018). */
		messageDeliveries = {},
		/** Questions asked inside this thread, by message id (migration 022). */
		threadRequests = {},
		/** The emoji on each message in this thread, by message id (migration 024). */
		messageReactions = {},
		/** The emoji on the card itself (migration 034). */
		reactions = [],
		/**
		 * Folded away by the owner (design §7).
		 *
		 * A collapsed card keeps its header and one line of what it said; the
		 * body, what it carried and the whole conversation are hidden until it is
		 * opened again. Handed down rather than held here, because the fold has to
		 * survive the card being replaced by id on every refetch.
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
		/** How many comments on this card the reader has not seen (design §7). */
		unread = 0,
		/** Called once the card has been on screen long enough to count as read. */
		onseen = undefined
	}: {
		update: UpdateView;
		agentName?: string;
		isNew?: boolean;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
		messages?: MessageView[];
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		onlineIds?: string[];
		messageMedia?: Record<string, MediaView[]>;
		/** The embeds on those messages, keyed by message id (migration 027). */
		messageEmbeds?: Record<string, EmbedView[]>;
		messageDeliveries?: Record<string, DeliveryView[]>;
		threadRequests?: Record<string, RequestView[]>;
		messageReactions?: Record<string, ReactionView[]>;
		reactions?: ReactionView[];
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
	 * The page's one ticking clock (design §7).
	 *
	 * Held for as long as this card is mounted so "4m ago" stops being a lie a
	 * minute after it is rendered, and released with the card — fifty cards share
	 * one timer rather than holding fifty.
	 */
	const ticking = clock();
	onMount(() => ticking.hold());

	/**
	 * When this card last changed (design §7). The owner: "when a card is updated
	 * for any reason, display how long ago it was updated, instead of how long ago
	 * it was created." The instant it was posted is still in the tooltip.
	 */
	const updatedAt = $derived(
		lastUpdatedAt(update.createdAt, messages, update.statusAt, update.editedAt)
	);

	const level = $derived(levelStyle(update.level));
	const poster = $derived(agentLabel(update.agentId, agentName));

	/**
	 * Posting the reply is the action client's job, not the card's: the write
	 * publishes `message.created`, the tab hears it on the stream and the thread
	 * refetches, so the reply arrives here the same way it arrives in a tab that
	 * was only watching (design §4).
	 */
	async function reply(body: string, mediaIds: string[] = [], answers?: string): Promise<void> {
		await actions?.postMessage({
			update: update.id,
			body,
			...(mediaIds.length > 0 ? { mediaIds } : {}),
			// The comment being answered, when the owner picked one (migration 020).
			// The reply still lands in this card's thread; the label is what tells
			// two conversations on one card apart.
			...(answers ? { answers } : {})
		});
	}
</script>

<article
	use:whenVisible={{
		// A folded card hides its thread, so being on screen is not reading it.
		enabled: unread > 0 && onseen !== undefined && !collapsed,
		onvisible: () => onseen?.()
	}}
	class="group relative flex gap-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-3 pr-4 pl-5 {isNew
		? 'update-enter'
		: ''}"
	data-level={update.level}
	data-bumped={bumped ? 'true' : undefined}
	data-update-id={update.id}
	aria-label="{level.label} update from {poster}"
	data-pinned={update.pinned ? 'true' : undefined}
>
	<!-- The level colour: the thing a long timeline is scanned by. -->
	<span class="absolute inset-y-0 left-0 w-1.5 {level.bar}" aria-hidden="true"></span>

	<Avatar name={poster} />

	<div class="flex min-w-0 flex-1 flex-col gap-2">
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
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<header
			class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm {oncollapse
				? 'cursor-pointer'
				: ''}"
			onclick={(event: MouseEvent) => {
				if (oncollapse && foldsOnClick(event)) oncollapse(!collapsed);
			}}
		>
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
			<UnreadBadge count={unread} />
			<time
				class="ml-auto text-xs whitespace-nowrap text-content-muted"
				datetime={new Date(updatedAt).toISOString()}
				title={updatedAt > update.createdAt
					? `Posted ${absoluteLabel(update.createdAt)} · updated ${absoluteLabel(updatedAt)}`
					: absoluteLabel(update.createdAt)}
				data-testid="update-time"
				data-updated={updatedAt > update.createdAt ? 'true' : undefined}
			>
				{updatedAt > update.createdAt ? 'updated ' : ''}{relativeLabel(updatedAt, ticking.now)}
			</time>
			<!--
				Where the work has got to (migration 035). In the header beside the
				level, because "is this being done" is read at the same glance as "did
				it go well".
			-->
			<StatusChip
				status={update.status}
				onstatus={actions
					? async (status) => {
							await actions.setCardStatus('update', update.id, status);
						}
					: undefined}
			/>
			{#if actions}
				<UpdateActions {update} {actions} {collapsed} {oncollapse} />
			{/if}
		</header>

		<!--
			The project's own words (migration 039). Under the header and above what
			the card says, which is where a label is read: "bug" before the report,
			not buried under it.
		-->
		<TagChips
			card={{ kind: 'update', id: update.id }}
			projectId={update.projectId}
			{tags}
			worn={cardTags}
			ontag={actions ? (tagId, on) => actions.tagCard('update', update.id, tagId, on) : undefined}
			oncreate={actions
				? async (name, colour) => {
						const made = await actions.defineTag(update.projectId ?? '', name, colour);
						await actions.tagCard('update', update.id, made.id, true);
					}
				: undefined}
			onrecolour={actions
				? async (tagId, colour) => {
						await actions.renameTag(tagId, { colour });
					}
				: undefined}
		/>

		{#if update.title}
			<!-- The title folds too, for the same reason the header does. -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<h3
				class="text-base font-semibold tracking-tight text-content {oncollapse
					? 'cursor-pointer'
					: ''}"
				onclick={(event: MouseEvent) => {
					if (oncollapse && foldsOnClick(event)) oncollapse(!collapsed);
				}}
			>
				{update.title}
			</h3>
		{/if}

		{#if collapsed}
			<!--
				One line of what it said, and what is hidden (design §7). A fold that
				showed only a name would be a row the owner has to open to find out
				whether they wanted it.
			-->
			<p class="min-w-0 truncate text-sm text-content-muted" data-testid="card-summary">
				{summaryOf(update.body) || 'No words on this card.'}
			</p>
			{#if messages.length > 0}
				<p class="text-xs text-content-muted" data-testid="card-hidden">
					{repliesLabel(messages.length)} hidden
				</p>
			{/if}
		{:else}
			<!--
				Shortened when it is long enough to own the screen, and untouched when
				it is not (design §7).
			-->
			<Clamp noun="the whole update">
				<Markdown body={update.body} />
			</Clamp>

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
			Whatever this card is portraying, in the style of where it came from
			(migration 027). Under the media rather than above it: a screenshot is
			what the agent saw, and an embed is what the agent is quoting.
		-->
			<Embeds items={update.embeds ?? []} />

			<!--
			The apps on this card (migration 041): interactive UI an agent shipped,
			run in a sandboxed frame. Collapsed until it is asked for — an app is
			somebody else's code, and scrolling past a card is not asking to run it.
		-->
			<Apps card={{ kind: 'update', id: update.id }} apps={cardApps} {actions} />

			<!--
			What is known about this card (migration 040): a branch, a pull request,
			whatever an agent noted. Hidden behind one line, because a feed is read
			by scanning what people said.
		-->
			<CardFields
				card={{ kind: 'update', id: update.id }}
				fields={cardFields}
				onset={actions
					? (name, value) => actions.setCardField('update', update.id, name, value)
					: undefined}
			/>

			<!--
			The emoji on the card itself (migration 034). Reactions were a message's
			alone, which made the quickest thing the owner could say impossible to
			say about the thing they were most often reading.
		-->
			{#if actions}
				<Reactions
					{reactions}
					{agentNames}
					onreact={async (emoji) => {
						await actions.reactToCard('update', update.id, emoji);
					}}
				/>
			{:else if reactions.length > 0}
				<Reactions {reactions} {agentNames} />
			{/if}

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
					embeds={messageEmbeds}
					{cardApps}
					deliveries={messageDeliveries}
					requests={threadRequests}
					reactions={messageReactions}
					{actions}
					uploader={actions}
					ondelete={async (id) => {
						await actions?.deleteMessage(id);
					}}
					onreply={reply}
				/>
			{/if}
		{/if}
	</div>
</article>
