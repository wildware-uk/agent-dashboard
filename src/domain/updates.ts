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
	findAgentById,
	findSessionById,
	findUpdateById,
	insertUpdate,
	listUpdates as listUpdateRows,
	setUpdatePinned as setPinnedFlag,
	softDeleteUpdate,
	type Update,
	type UpdateLevel
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
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

	// Checked first: attaching after the insert would leave a posted update whose
	// media quietly went missing.
	const mediaIds =
		input.mediaIds === undefined || input.mediaIds.length === 0
			? []
			: assertAttachable(ctx, { mediaIds: input.mediaIds, agentId: agent.id });

	const update = insertUpdate(ctx.db, {
		projectId: project.id,
		agentId: agent.id,
		sessionId,
		title,
		body,
		level: input.level ?? 'info',
		createdAt: ctx.now()
	});

	if (mediaIds.length > 0) {
		attachMediaToUpdate(ctx.db, { mediaIds, updateId: update.id, agentId: agent.id });
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
 * Quiet when the flag already says what was asked for, for the same reason
 * {@link deleteUpdate} is: a `update.updated` that changed nothing would make
 * every open tab refetch a timeline that cannot have moved.
 *
 * A deleted update cannot be pinned. It is gone from every timeline, so pinning
 * it would put a row nobody can see at the top of an order nobody can read.
 *
 * @throws {DomainError} `not_found` if there is no such live update.
 */
export function setUpdatePinned(ctx: DomainContext, updateId: string, pinned: boolean): Update {
	const update = findUpdateById(ctx.db, updateId);
	if (!update || update.deletedAt !== null) throw notFound(`no such update: ${updateId}`);
	if (update.pinned === pinned) return update;

	// The row was just read and this is a single-process deployment (design §2),
	// so a missing row here would be a bug, not a race.
	const saved = setPinnedFlag(ctx.db, update.id, pinned)!;
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
