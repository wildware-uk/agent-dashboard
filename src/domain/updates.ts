/**
 * Updates: the timeline agents post into (design §3, §5).
 *
 * Two rules here are worth stating out loud, because the browser depends on
 * both. Pagination is by `seq` cursor, never by offset, so a page stays correct
 * while agents keep posting above it. Deletes are soft, so a browser that has
 * already rendered a card can be told to drop it.
 */
import {
	attachMediaToUpdate,
	editUpdateRow,
	findAgentById,
	findSessionById,
	findUpdateById,
	insertUpdate,
	listUpdates as listUpdateRows,
	softDeleteUpdate,
	type Update,
	type UpdateLevel,
	type UpdatePriority
} from '$db';
import { pinCard } from './cards';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { attachEmbeds, checkedEmbeds, type NewEmbedInput } from './embeds';
import { attachApps, checkedApps, type NewAppInput } from './apps';
import { assertAttachable } from './media';
import { resolveProject } from './projects';
import { optionalText, requiredText } from './text';

/** Long enough for a real report with a stack trace; short enough to store. */
export const BODY_MAX_LENGTH = 100_000;
export const TITLE_MAX_LENGTH = 200;

/** How many updates a page holds when the caller does not say. */
export const DEFAULT_LIMIT = 50;
/** The most one page will ever return, however large a limit is asked for. */
export const MAX_LIMIT = 200;

export type PostUpdateInput = {
	/** A project slug or id (design §5). */
	project: string;
	/**
	 * The agent posting. Adapters resolve this from the bearer token and never
	 * from a caller-supplied argument, so one agent cannot post as another (§5).
	 */
	agentId: string;
	/** Markdown. Untrusted: it renders with raw HTML disabled (design §8). */
	body: string;
	title?: string | null;
	level?: UpdateLevel;
	/** How much this needs the owner now (design §7). Defaults to `medium`. */
	priority?: UpdatePriority;
	sessionId?: string | null;
	/**
	 * Uploads to show on the card (design §5).
	 *
	 * Ids from `create_upload`, whose bytes have already landed. Checked before
	 * anything is written and attached before the event goes out, so the post
	 * either arrives complete or does not happen: an image the agent believes it
	 * published must not be silently dropped. Media that lands *after* the post
	 * is `attach_media`'s job instead.
	 */
	mediaIds?: readonly string[];
	/**
	 * Things to show on the card in a registered look (migration 027).
	 *
	 * Checked before the insert for the same reason `mediaIds` is: a card that
	 * published without the Slack message it was about is worse than one that
	 * failed to post and said which embed was wrong.
	 */
	embeds?: readonly NewEmbedInput[];
	/**
	 * Interactive UI to put on the card (migration 041).
	 *
	 * Checked before the insert for the same reason the embeds are, and named the
	 * same way an agent names one everywhere else: by its `ui://` URI.
	 */
	apps?: readonly NewAppInput[];
};

/** Post one update and announce it. */
export function postUpdate(ctx: DomainContext, input: PostUpdateInput): Update {
	const project = resolveProject(ctx, input.project);
	const agent = findAgentById(ctx.db, input.agentId);
	if (!agent) throw notFound(`no such agent: ${input.agentId}`);

	const body = requiredText(input.body, 'body', BODY_MAX_LENGTH);
	const title = optionalText(input.title, 'title', TITLE_MAX_LENGTH);
	const sessionId = input.sessionId ?? null;
	if (sessionId !== null) {
		const session = findSessionById(ctx.db, sessionId);
		if (!session) throw notFound(`no such session: ${sessionId}`);
		// Belongs-to check, not a formality: the session is what the UI groups a
		// run by, so attributing one agent's update to another's session would
		// misreport who did the work.
		if (session.agentId !== agent.id) throw invalid('session belongs to another agent');
	}

	// `task_id` is never set any more: the board is gone and a card is the work
	// (migration 035). The column stays because dropping one is a table rebuild
	// for nothing, and its old values are the history of what was filed where.
	const taskId = null;

	// Checked first: attaching after the insert would leave a posted update whose
	// media quietly went missing.
	const mediaIds =
		input.mediaIds === undefined || input.mediaIds.length === 0
			? []
			: assertAttachable(ctx, { mediaIds: input.mediaIds, agentId: agent.id });

	// Same rule, same reason: an unknown embed type is caught while there is
	// still nothing on the timeline to be missing anything.
	const embeds = input.embeds?.length ? checkedEmbeds(ctx, input.embeds) : [];
	const apps = input.apps?.length ? checkedApps(ctx, input.apps) : [];

	const update = insertUpdate(ctx.db, {
		projectId: project.id,
		agentId: agent.id,
		sessionId,
		title,
		body,
		level: input.level ?? 'info',
		priority: assertPriority(input.priority ?? 'medium'),
		taskId,
		createdAt: ctx.now()
	});

	if (mediaIds.length > 0) {
		attachMediaToUpdate(ctx.db, { mediaIds, updateId: update.id, agentId: agent.id });
	}

	if (embeds.length > 0) {
		attachEmbeds(ctx, {
			embeds,
			updateId: update.id,
			agentId: agent.id,
			author: `agent:${agent.id}`
		});
	}

	if (apps.length > 0) {
		attachApps(ctx, {
			apps,
			card: { kind: 'update', id: update.id },
			agentId: agent.id,
			author: `agent:${agent.id}`
		});
	}

	ctx.bus.publish('update.created', {
		updateId: update.id,
		projectId: update.projectId,
		agentId: update.agentId
	});

	return update;
}

export type ListUpdatesInput = {
	/** A project slug or id. Omit for the whole timeline. */
	project?: string;
	agentId?: string;
	/** Defaults to {@link DEFAULT_LIMIT}, capped at {@link MAX_LIMIT}. */
	limit?: number;
	/** `nextCursor` from the previous page. Omit or pass `null` for the first. */
	cursor?: string | null;
	/** Include soft-deleted rows. The browser asks for this when reconciling. */
	includeDeleted?: boolean;
};

/** One page of the timeline, newest first, plus how to ask for the next. */
export type UpdatePage = {
	updates: Update[];
	/** Pass back as `cursor`. `null` when this is the last page. */
	nextCursor: string | null;
	hasMore: boolean;
};

/**
 * A page of the timeline.
 *
 * The cursor is the `seq` of the last row handed out, and `seq` is an
 * `AUTOINCREMENT` that is never reused, so paging asks for "older than row 41"
 * rather than "rows 20 to 40". Updates arriving mid-scroll therefore cannot
 * shift a page: they land above the cursor, where the reader has already been.
 */
export function listUpdates(ctx: DomainContext, input: ListUpdatesInput = {}): UpdatePage {
	const limit = pageLimit(input.limit);
	const beforeSeq = decodeCursor(input.cursor);
	const projectId = input.project === undefined ? undefined : resolveProject(ctx, input.project).id;

	// One extra row answers "is there a next page?" without a second query.
	const rows = listUpdateRows(ctx.db, {
		projectId,
		agentId: input.agentId,
		beforeSeq,
		includeDeleted: input.includeDeleted,
		limit: limit + 1
	});

	const hasMore = rows.length > limit;
	const updates = hasMore ? rows.slice(0, limit) : rows;
	const last = updates.at(-1);

	return {
		updates,
		hasMore,
		nextCursor: hasMore && last ? encodeCursor(last.seq) : null
	};
}

/**
 * Soft-delete an update and tell the browsers that rendered it (design §3).
 *
 * Idempotent, and deliberately quiet the second time: the row is already gone
 * from every timeline, so a second `update.deleted` would be an event announcing
 * nothing.
 */
/**
 * One update by id, deleted or not.
 *
 * For adapters holding an id that need the row — the agent stream deciding
 * whether a reaction is on a card this agent posted. `$http` may see the domain
 * and nothing below it (design §2), so the lookup lives here.
 */
export function findUpdate(ctx: DomainContext, updateId: string): Update | undefined {
	return findUpdateById(ctx.db, updateId);
}

export function deleteUpdate(ctx: DomainContext, updateId: string): Update {
	const update = findUpdateById(ctx.db, updateId);
	if (!update) throw notFound(`no such update: ${updateId}`);
	if (update.deletedAt !== null) return update;

	softDeleteUpdate(ctx.db, update.id, ctx.now());
	ctx.bus.publish('update.deleted', { updateId: update.id, projectId: update.projectId });

	return findUpdateById(ctx.db, update.id)!;
}

/**
 * Pin or unpin an update (design §7).
 *
 * The act itself lives in `./cards.ts` since migration 034, because it is not
 * an update's alone any more: the owner asked to pin their own posts, and a
 * feed where one kind of thing can be kept in view and the others cannot is a
 * feed that has decided for them what matters. This is the update-shaped door
 * onto it, kept because the route and the card both speak in updates.
 *
 * Quiet when the flag already says what was asked for, for the same reason
 * {@link deleteUpdate} is: an `update.updated` that changed nothing would make
 * every open tab refetch a timeline that cannot have moved. A deleted update
 * cannot be pinned — it is gone from every timeline, so pinning it would put a
 * row nobody can see at the top of an order nobody can read.
 *
 * @throws {DomainError} `not_found` if there is no such live update.
 */
export function setUpdatePinned(ctx: DomainContext, updateId: string, pinned: boolean): Update {
	pinCard(ctx, { card: { kind: 'update', id: updateId }, pinned });
	return findUpdateById(ctx.db, updateId)!;
}

/** The four levels (design §3), so an edit cannot invent a fifth. */
export const UPDATE_LEVELS = ['info', 'success', 'warn', 'error'] as const;

/**
 * How much an update needs the owner now (design §7).
 *
 * Deliberately three, and deliberately not the same axis as `level`. Level is
 * what happened and colours the card; priority is whether it can wait, and is
 * what a phone at 2am filters on. An agent that has to express "this failed but
 * it does not matter" needs both, and a single field would make it choose.
 */
export const UPDATE_PRIORITIES = ['low', 'medium', 'high'] as const;

/** A priority, checked. The default is `medium`: most things are ordinary. */
function assertPriority(priority: UpdatePriority): UpdatePriority {
	if (!UPDATE_PRIORITIES.includes(priority)) {
		throw invalid(`priority must be one of: ${UPDATE_PRIORITIES.join(', ')}`);
	}
	return priority;
}

/**
 * A level, checked.
 *
 * `post_update` gets this for free from its zod enum, but an edit is a second
 * door onto the same column and a level SQLite would happily store is one the
 * card cannot colour.
 */
function assertLevel(level: UpdateLevel): UpdateLevel {
	if (!UPDATE_LEVELS.includes(level)) {
		throw invalid(`level must be one of: ${UPDATE_LEVELS.join(', ')}`);
	}
	return level;
}

export type EditUpdateInput = {
	updateId: string;
	/**
	 * The agent doing the editing. Adapters resolve this from the bearer token and
	 * never from a caller-supplied argument (design §5).
	 */
	agentId: string;
	/** Omit to leave it; `null` clears it. */
	title?: string | null;
	/** Omit to leave it. Markdown, untrusted, rendered with raw HTML off (§8). */
	body?: string;
	/** Omit to leave it. An agent that got the severity wrong can correct it. */
	level?: UpdateLevel;
	/** Omit to leave it. Something that has stopped mattering can be demoted. */
	priority?: UpdatePriority;
};

/**
 * An agent corrects its own update (design §3, §5).
 *
 * **Only its own.** The author is taken from the bearer token, and an update
 * posted by another agent is refused rather than silently ignored: agents share
 * a timeline, and one rewriting another's report would make the wall unreliable
 * in the one way that matters. The owner is not offered this at all — their
 * controls are the pin and the delete, because a human editing an agent's report
 * would make attribution a lie.
 *
 * **The edit is stamped and the card says so.** `edited_at` moves, `created_at`
 * does not: a corrected update stays where the owner last saw it instead of
 * jumping the feed, and the card carries an "edited" marker so nobody has to
 * wonder whether they misread it (migration 004).
 *
 * **An edit that changes nothing is still an edit.** Unlike
 * {@link setUpdatePinned}, this does not go quiet when the new text equals the
 * old: the agent asked to write, the write happened, and reporting success for a
 * no-op it did not make is the more confusing answer. It does refuse an edit
 * that names no field, which is a caller bug rather than a no-op.
 *
 * @throws {DomainError} `not_found` for an unknown or deleted update,
 *   `invalid_argument` for another agent's update, an empty body, or no fields.
 */
export function editUpdate(ctx: DomainContext, input: EditUpdateInput): Update {
	const update = findUpdateById(ctx.db, input.updateId);
	if (!update || update.deletedAt !== null) throw notFound(`no such update: ${input.updateId}`);
	if (update.agentId !== input.agentId) {
		throw invalid('that update was posted by another agent');
	}

	const edit: Parameters<typeof editUpdateRow>[2] = { editedAt: ctx.now() };
	if (input.title !== undefined) edit.title = optionalText(input.title, 'title', TITLE_MAX_LENGTH);
	if (input.body !== undefined) edit.body = requiredText(input.body, 'body', BODY_MAX_LENGTH);
	if (input.level !== undefined) edit.level = assertLevel(input.level);
	if (input.priority !== undefined) edit.priority = assertPriority(input.priority);

	if (
		edit.title === undefined &&
		edit.body === undefined &&
		edit.level === undefined &&
		edit.priority === undefined
	) {
		throw invalid('an edit must change the title, the body, the level or the priority');
	}

	// The row was read a moment ago in a single-process deployment (design §2), so
	// a miss here would be a bug rather than a race.
	const saved = editUpdateRow(ctx.db, update.id, edit)!;

	// The same event a pin publishes: an identifier and enough for a subscriber to
	// decide whether it cares. The browser refetches the row either way, so an
	// edited body never travels on the bus (design §4).
	ctx.bus.publish('update.updated', {
		updateId: saved.id,
		projectId: saved.projectId,
		pinned: saved.pinned
	});

	return saved;
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
	return Math.min(limit, MAX_LIMIT);
}

/** Cursors are opaque to callers, which is why they are encoded and decoded here. */
function encodeCursor(seq: number): string {
	return String(seq);
}

function decodeCursor(cursor: string | null | undefined): number | undefined {
	if (cursor === undefined || cursor === null || cursor === '') return undefined;
	if (!/^[0-9]+$/.test(cursor)) throw invalid('cursor is not one this server issued');
	return Number(cursor);
}
