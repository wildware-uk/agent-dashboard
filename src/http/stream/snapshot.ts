/**
 * The snapshot endpoints a client falls back on after a `resync` (design §4).
 *
 * The stream is an incremental protocol, and every incremental protocol needs a
 * way to start over. When the ring buffer cannot cover a client's gap the stream
 * says `resync` once; this is what the client then fetches to rebuild state from
 * scratch, and it is also what a freshly loaded page reads before it has any
 * events at all.
 *
 * The one subtle rule: **the stream cursor is read before the state**. The
 * client trusts `seq` to mean "this state accounts for every event up to here",
 * and then applies stream frames newer than it. Reading the cursor afterwards
 * would let an event published mid-read be dismissed as already-included when it
 * was not, and the browser would sit on stale data until the next reconnect.
 * Reading it first can only cause an event to be applied twice, which is
 * harmless: every payload is an identifier the client reconciles against, never
 * a delta.
 */
import { EventBus, bus as sharedBus } from '$events';
import {
	context,
	type DomainContext,
	isDomainError,
	listAgentNames,
	listProjects,
	listThread,
	listUpdateEmbeds,
	listUpdateMedia,
	acknowledgementsFor,
	listMessageEmbeds,
	listMessageMedia,
	listUpdateShares,
	appsForCards,
	fieldsForCards,
	listPendingRequests,
	listTags,
	listUpdates,
	reactionsFor,
	tagsForCards,
	type EmbedView,
	type MediaAttachment,
	type AppViewData,
	type CardField,
	type CardTag,
	type Reaction as ReactionView,
	type Tag
} from '$domain';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse } from './owner';

/** Timeline rows per page when the client does not ask for a size. */
export const SNAPSHOT_DEFAULT_LIMIT = 50;

/** Which slice of state the client wants. Every field is optional. */
export type SnapshotQuery = {
	/** A project slug or id. Omit for the whole timeline. */
	project?: string;
	/**
	 * Only the updates filed against this task (design §7).
	 *
	 * The feed filtered to one piece of long-running work, which is what clicking
	 * a task on the board does. Server-side rather than in the browser, because
	 * the browser has one page of the timeline and the task's history may run
	 * further back than that page reaches.
	 */
	task?: string;
	/** Restrict the project list. Omit for every project, archived included. */
	status?: 'active' | 'archived';
	/** Timeline page size. */
	limit: number;
	/** `nextCursor` from a previous page. */
	cursor?: string;
};

/**
 * The domain's own shapes, named without importing `$db`.
 *
 * `$http` may not reach past `$domain` (design §2), and `$domain` exports the
 * functions rather than the row types, so the row types are recovered from the
 * signatures. This is not cosmetic: it means the wire format cannot drift from
 * what the domain actually returns, because there is no second declaration of it
 * to drift.
 */
export type SnapshotProjects = ReturnType<typeof listProjects>;

/**
 * An update as the timeline sends it: the domain's row plus its media (design §7).
 *
 * The media rides on the card rather than in a map beside the timeline, and that
 * is what makes the live swap fall out of the transport already in place: a
 * browser hearing `media.ready` refetches this page and replaces the row by id
 * (`src/web/timeline.svelte.ts`), so the new variants arrive with the row that
 * renders them and there is no second piece of state to reconcile.
 *
 * Always an array, never absent: a card that reads `media.length` should not
 * have to guard against a plain-text update.
 */
export type SnapshotUpdate = ReturnType<typeof listUpdates>['updates'][number] & {
	media: MediaAttachment[];
	/**
	 * The embeds on this card (migration 027), on the same terms as its media:
	 * always an array, and carrying the look each one is drawn in, so a card
	 * arriving on the stream can be rendered without a registry the client would
	 * have to keep in step.
	 */
	embeds: EmbedView[];
	/**
	 * The public link on this card, if it has one (design §7, §8).
	 *
	 * Present only when the card is shared, so the owner can see at a glance which
	 * of their timeline is public and how often each link has been opened. Never
	 * the token: only its HMAC is stored, and there is no endpoint that could hand
	 * the URL back (`src/domain/shares.ts`).
	 */
	share?: { views: number; sharedAt: number };
	/**
	 * The emoji on the card itself (migration 034).
	 *
	 * Riding with the card for the same reason its media does: the owner asked
	 * for the card types to stop differing, and a reaction fetched separately
	 * would paint a beat after the thing it is on.
	 */
	reactions: ReactionView[];
};

export type SnapshotUpdates = {
	items: SnapshotUpdate[];
	/** Pass back as `cursor` to page further into the past. `null` at the end. */
	nextCursor: string | null;
	hasMore: boolean;
};

/**
 * Agent id to display name, for every agent this deployment knows (design §7).
 *
 * Rides with the timeline rather than with presence because it answers a
 * different question: presence is "who is beating right now", and a timeline is
 * mostly the work of agents that have gone away. A card that cannot name its
 * poster falls back to an id, which is unreadable — every ULID begins `01` until
 * 2039 — so the names travel in the same document as the updates they annotate,
 * which also means a `resync` refetch repairs them for free.
 */
export type SnapshotAgentNames = Record<string, string>;

/** Everything a resyncing client needs in one consistent read. */
/**
 * Every thread the page can show, from the same domain call `GET /api/messages`
 * uses.
 *
 * In the snapshot rather than fetched on mount: without it the page painted and
 * then a card's replies appeared a beat later, which reads as the thread having
 * been empty and then filling in. Scoped to the same project as the timeline, so
 * a project view does not carry the whole deployment's conversation.
 */
export type SnapshotMessages = ReturnType<typeof listThread>;

/**
 * What agents have said about the messages in this snapshot (migration 013).
 *
 * Rides with the threads for the same reason the threads ride with the timeline:
 * without it the page paints a reply and then a tick appears a beat later, which
 * reads as the acknowledgement having just arrived when it is minutes old.
 */
export type SnapshotAcks = ReturnType<typeof acknowledgementsFor>;

/** The images on the messages in this snapshot, keyed by message id. */
export type SnapshotMessageMedia = Record<string, MediaAttachment[]>;

/**
 * The embeds on those messages, keyed by message id (migration 027).
 *
 * Its own map beside the media's, for the same reason that one is its own map:
 * an embed is a property of the message that came back, not a filter on which
 * messages come back, and a thread of plain replies costs no keys at all.
 */
export type SnapshotMessageEmbeds = Record<string, EmbedView[]>;

/**
 * A project's own words, and where they are worn (migration 039).
 *
 * Two lists rather than tags folded into each card: the picker on every card
 * needs the project's whole vocabulary whether or not this page happens to show
 * a card wearing each word, and a definition repeated on forty cards would be
 * forty copies of the same three facts.
 */
export type SnapshotTags = Tag[];
export type SnapshotCardTags = CardTag[];

/**
 * What is known about the cards on this page (migration 040).
 *
 * A flat list for the reason the tags are one: the client keys it by card, and
 * a map nested per kind would be three shapes to merge rather than one to
 * filter.
 */
export type SnapshotCardFields = CardField[];

/**
 * The apps showing on the cards on this page (migration 041).
 *
 * A flat list for the reason the fields are one: the client keys it by card, and
 * an app is a property of the card it is on rather than a filter on which cards
 * came back.
 */
export type SnapshotCardApps = AppViewData[];

export type FullSnapshot = {
	projects: SnapshotProjects;
	tags: SnapshotTags;
	cardTags: SnapshotCardTags;
	cardFields: SnapshotCardFields;
	cardApps: SnapshotCardApps;
	updates: SnapshotUpdates;
	agentNames: SnapshotAgentNames;
	messages: SnapshotMessages;
	acks: SnapshotAcks;
	messageMedia: SnapshotMessageMedia;
	messageEmbeds: SnapshotMessageEmbeds;
};

/** Just the timeline, for paging and for a scoped refetch. */
export type UpdatesSnapshot = { updates: SnapshotUpdates };

/** What the endpoint sends: the state, stamped with the cursor it is good to. */
export type Snapshot<State extends object> = State & {
	/** The newest event seq accounted for. Discard stream frames at or below it. */
	seq: number;
	at: string;
};

/** Reads state for a query. Injected, so the handler is testable without a database. */
export type SnapshotReader<State extends object> = (
	query: SnapshotQuery,
	ctx?: DomainContext
) => State;

/** The slice of SvelteKit's `RequestEvent` a snapshot route needs. */
export type SnapshotRequestEvent = {
	request: Request;
	url: URL;
	cookies: SessionCookieReader;
};

export type SnapshotHandlerOptions<State extends object> = {
	read: SnapshotReader<State>;
	bus?: EventBus;
	config?: () => AuthConfig | null;
};

/** A `DomainError` code is the domain's vocabulary; this is HTTP's (design §2). */
const STATUS_FOR = {
	invalid_argument: 400,
	not_found: 404,
	conflict: 409
} as const;

/** Projects plus the newest page of the timeline: the post-`resync` refetch. */
export function readFullSnapshot(
	query: SnapshotQuery,
	ctx: DomainContext = context()
): FullSnapshot {
	// Deliberately in this order: the project list is what the sidebar needs
	// first, and a slug that does not resolve should fail before a timeline query
	// runs.
	const projects = listProjects(ctx, query.status ? { status: query.status } : {});
	// Every agent, not only the ones on this page: paging deeper into the past
	// must not reach an update whose poster the client cannot name, and the whole
	// map is smaller than one card's markdown.
	const messages = listThread(ctx, query.project ? { project: query.project } : {});
	const updates = readUpdates(query, ctx);
	// The cards on this page, in the three kinds that can carry a word. Requests
	// are read for the whole scope rather than per page: there are never many
	// pending at once, and one that is waiting on the owner is the card most
	// likely to be labelled.
	const onPage = {
		update: updates.items.map((update) => update.id),
		message: messages.map((message) => message.id),
		// Every pending question, not this page's: there are never many, and one
		// waiting on the owner is the card most likely to be labelled.
		request: listPendingRequests(ctx).map((request) => request.id)
	};
	const cardTags = tagsForCards(ctx, onPage);
	const cardFields = fieldsForCards(ctx, onPage);
	const cardApps = appsForCards(ctx, onPage);

	return {
		projects,
		tags: listTags(ctx, { project: query.project ?? null }),
		cardTags,
		cardFields,
		cardApps,
		updates,
		agentNames: listAgentNames(ctx),
		messages,
		acks: acknowledgementsFor(ctx, { message: messages.map((message) => message.id) }),
		messageMedia: Object.fromEntries(
			messages
				.map((message) => [message.id, listMessageMedia(ctx, message.id)] as const)
				.filter(([, media]) => media.length > 0)
		),
		messageEmbeds: Object.fromEntries(
			messages
				.map((message) => [message.id, listMessageEmbeds(ctx, message.id)] as const)
				.filter(([, embeds]) => embeds.length > 0)
		)
	};
}

/** The timeline alone, for paging deeper or refetching one project. */
export function readUpdatesSnapshot(
	query: SnapshotQuery,
	ctx: DomainContext = context()
): UpdatesSnapshot {
	return { updates: readUpdates(query, ctx) };
}

function readUpdates(query: SnapshotQuery, ctx: DomainContext): SnapshotUpdates {
	const page = listUpdates(ctx, {
		project: query.project,
		limit: query.limit,
		cursor: query.cursor
	});

	// One read for the whole page, after the page is known — media is a property
	// of the rows that came back, not a filter on which rows come back.
	const media = listUpdateMedia(
		ctx,
		page.updates.map((update) => update.id)
	);
	const embeds = listUpdateEmbeds(
		ctx,
		page.updates.map((update) => update.id)
	);
	const shares = listUpdateShares(
		ctx,
		page.updates.map((update) => update.id)
	);
	const reactions = reactionsFor(
		ctx,
		'update',
		page.updates.map((update) => update.id)
	);
	const items = page.updates.map((update) => ({
		...update,
		media: media[update.id] ?? [],
		embeds: embeds[update.id] ?? [],
		reactions: reactions.filter((reaction) => reaction.card.id === update.id),
		...(shares[update.id] ? { share: shares[update.id] } : {})
	}));

	return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

/**
 * Build a `GET` handler around a reader.
 *
 * Both snapshot routes are this function with a different reader, so the cursor
 * rule, the auth check and the error mapping exist once.
 */
export function createSnapshotHandler<State extends object>({
	read,
	bus = sharedBus,
	config
}: SnapshotHandlerOptions<State>): (event: SnapshotRequestEvent) => Response {
	return (event) => {
		if (!ownerAuthenticated(event, config)) return unauthenticatedResponse();

		// Before the read. See the note at the top of this file.
		const seq = bus.lastSeq;

		let state: State;
		try {
			state = read(readSnapshotQuery(event.url));
		} catch (error) {
			if (!isDomainError(error)) throw error;
			return json(STATUS_FOR[error.code], { error: error.code, message: error.message });
		}

		const snapshot: Snapshot<State> = { seq, at: new Date().toISOString(), ...state };
		return json(200, snapshot);
	};
}

/**
 * Read the query string.
 *
 * A malformed filter is dropped rather than rejected: the client that sent it is
 * mid-recovery, and answering a bad `limit` with a 400 turns a cosmetic bug into
 * a dashboard that never repopulates. A `project` that does not exist is a
 * different matter — the domain reports that, and it becomes a 404.
 */
export function readSnapshotQuery(url: URL): SnapshotQuery {
	const params = url.searchParams;
	const query: SnapshotQuery = {
		limit: positiveInt(params.get('limit')) ?? SNAPSHOT_DEFAULT_LIMIT
	};

	const project = params.get('project')?.trim();
	if (project) query.project = project;

	const cursor = params.get('cursor')?.trim();
	if (cursor) query.cursor = cursor;

	const task = params.get('task')?.trim();
	if (task) query.task = task;

	const status = params.get('status');
	if (status === 'active' || status === 'archived') query.status = status;

	return query;
}

function positiveInt(raw: string | null): number | undefined {
	if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			// State that is only correct as of `seq`, so a cache must never re-serve it.
			'cache-control': 'no-store'
		}
	});
}
