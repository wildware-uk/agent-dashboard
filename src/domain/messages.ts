/**
 * Messages: the owner talking back to agents, and agents answering (design §3, §5).
 *
 * Two rules from §3 shape every function here.
 *
 * **`author` is a string, not a foreign key.** It is either the literal `human`
 * or `agent:<agent_id>`, because the owner is not a row: there is no user table
 * in a single-owner deployment (§1), so a nullable `agent_id` plus a flag would
 * be two columns encoding one fact. {@link authorText} and {@link parseAuthor}
 * are the only two places that format is written down.
 *
 * **Unread state lives in `read_cursors`, never as a flag on `messages`.** A
 * message is a row that happened; how far a given reader has got through them is
 * that reader's business. So "unread" is a comparison — `messages.seq` against
 * one integer per agent — and a second reader is a second row rather than a
 * schema change. That is also what makes {@link readMessages} safe to call twice
 * concurrently: the cursor only ever moves forward (`advanceReadCursor` takes a
 * `max`), so the slower of two overlapping reads cannot un-read the faster one's
 * messages.
 *
 * The one subtlety worth reading before changing anything: **a read only ever
 * advances the cursor over messages it actually handed over.** A read filtered
 * to one project, or resumed from an explicit `since`, would otherwise walk the
 * cursor past messages the agent has never seen — and since the heartbeat's
 * unread count is derived from that same cursor, they would be lost silently
 * rather than loudly. {@link readMessages} therefore stops the cursor at the
 * first unread message it did not return.
 *
 * The consequence is at-least-once delivery: a narrowed read can hand the same
 * message over twice, because the cursor is one position and may not pass what
 * the read stepped over. That is the right way round — an agent re-reading an
 * instruction costs a paragraph, an agent never seeing one is a silent failure.
 */
import {
	advanceReadCursor,
	countMessagesAfter,
	findAgentById,
	findTaskById,
	findUpdateById,
	insertMessage,
	listMessages,
	readCursorSeq,
	type Message
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { resolveProject } from './projects';
import { requiredText } from './text';

/**
 * Long enough for a real instruction with a snippet in it, short enough that a
 * thread stays readable on a phone. Two orders of magnitude under an update
 * body: a message is a remark, not a report.
 */
export const MESSAGE_BODY_MAX_LENGTH = 10_000;

/** How many messages one read hands over when the caller does not say. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** The most one read will ever hand over, however large a limit is asked for. */
export const MAX_MESSAGE_LIMIT = 200;

/** The owner. Not a row, so not an id (design §1, §3). */
export const HUMAN_AUTHOR = 'human';
/** What an agent's author string starts with. */
export const AGENT_AUTHOR_PREFIX = 'agent:';

/** Who wrote a message, before it is flattened into `messages.author`. */
export type MessageAuthor = { kind: 'human' } | { kind: 'agent'; agentId: string };

/** `human`, or `agent:<agent_id>` (design §3). */
export function authorText(author: MessageAuthor): string {
	return author.kind === 'human' ? HUMAN_AUTHOR : `${AGENT_AUTHOR_PREFIX}${author.agentId}`;
}

/**
 * Read an author string back.
 *
 * `null` for anything this module did not write, rather than a guess: a stored
 * author it cannot parse is a bug worth seeing, and inventing a human out of it
 * would attribute an agent's words to the owner.
 */
export function parseAuthor(author: string): MessageAuthor | null {
	if (author === HUMAN_AUTHOR) return { kind: 'human' };
	if (!author.startsWith(AGENT_AUTHOR_PREFIX)) return null;
	const agentId = author.slice(AGENT_AUTHOR_PREFIX.length);
	return agentId === '' ? null : { kind: 'agent', agentId };
}

export type PostMessageInput = {
	/**
	 * Who is writing. Adapters resolve an agent from its bearer token and the
	 * owner from the session cookie, never from a caller-supplied argument (§5).
	 */
	author: MessageAuthor;
	/** Markdown. Untrusted, and rendered with raw HTML disabled (design §8). */
	body: string;
	/** A project slug or id. Derived from the update or task when one is given. */
	project?: string | null;
	/** The update this is a reply on. */
	updateId?: string | null;
	/** The task this is about. */
	taskId?: string | null;
};

/**
 * Post one message and announce it.
 *
 * A message hangs off at most one thing — an update *or* a task — and its
 * project is derived from whichever that was, so the project a message belongs
 * to is never a second, disagreeing copy of the anchor's. Naming a project that
 * contradicts the anchor is refused rather than reconciled.
 *
 * @throws {DomainError} `not_found` for an unknown project, update, task or
 *   agent; `invalid_argument` for a blank body, two anchors, or an anchor from a
 *   different project than the one named.
 */
export function postMessage(ctx: DomainContext, input: PostMessageInput): Message {
	const body = requiredText(input.body, 'body', MESSAGE_BODY_MAX_LENGTH);
	const author = authorText(assertAuthor(ctx, input.author));

	const updateId = input.updateId ?? null;
	const taskId = input.taskId ?? null;
	if (updateId !== null && taskId !== null) {
		throw invalid('a message hangs off an update or a task, not both');
	}

	// The named project first, so an unknown slug is refused before anything else,
	// and then the anchor's. A request that says both and disagrees is refused
	// rather than quietly resolved: silently preferring one would file the message
	// somewhere the caller did not ask for and report success.
	const named = input.project ? resolveProject(ctx, input.project).id : null;
	const anchored = anchorProject(ctx, { updateId, taskId });
	if (anchored !== null && named !== null && anchored !== named) {
		throw invalid('that update or task belongs to a different project');
	}
	const projectId = anchored ?? named;

	const message = insertMessage(ctx.db, {
		projectId,
		updateId,
		taskId,
		author,
		body,
		createdAt: ctx.now()
	});

	ctx.bus.publish('message.created', {
		messageId: message.id,
		projectId: message.projectId,
		author: message.author
	});

	return message;
}

export type ReadMessagesInput = {
	/**
	 * The agent reading. Adapters resolve this from the bearer token and never
	 * from a caller-supplied argument (design §5).
	 */
	agentId: string;
	/**
	 * Read from here instead of from the agent's own cursor. A `cursor` from a
	 * previous read; opaque to the caller.
	 */
	since?: string | null;
	/** A project slug or id. Omit for every message waiting. */
	project?: string | null;
	/** Defaults to true, and advances the agent's cursor (design §5). */
	markRead?: boolean;
	/** Defaults to {@link DEFAULT_MESSAGE_LIMIT}, capped at {@link MAX_MESSAGE_LIMIT}. */
	limit?: number;
};

/** One read: what was waiting, where the agent got to, and what is left. */
export type MessagePage = {
	/** Oldest first: a conversation being caught up on, not a feed. */
	messages: Message[];
	/** Pass back as `since`. */
	cursor: string;
	/** How many messages are still unread *after* this call, in every project. */
	unread: number;
	/** Whether this call moved the agent's cursor. */
	markedRead: boolean;
};

/**
 * What is waiting for one agent.
 *
 * An agent never reads its own messages back: they are in the same table as the
 * owner's, and a reply the agent wrote is not news to it.
 *
 * @throws {DomainError} `not_found` for an unknown agent or project,
 *   `invalid_argument` for a bad limit or a cursor this server did not issue.
 */
export function readMessages(ctx: DomainContext, input: ReadMessagesInput): MessagePage {
	const agent = findAgentById(ctx.db, input.agentId);
	if (!agent) throw notFound(`no such agent: ${input.agentId}`);

	const mine = authorText({ kind: 'agent', agentId: agent.id });
	const limit = pageLimit(input.limit);
	const projectId = input.project ? resolveProject(ctx, input.project).id : undefined;
	const cursorSeq = readCursorSeq(ctx.db, agent.id);
	const from = decodeCursor(input.since) ?? cursorSeq;

	const messages = listMessages(ctx.db, {
		afterSeq: from,
		projectId,
		excludeAuthor: mine,
		limit
	});

	const markRead = input.markRead ?? true;
	if (markRead) {
		advanceReadCursor(
			ctx.db,
			agent.id,
			readTo(ctx, { cursorSeq, from, mine, limit, projectId, messages })
		);
	}

	const last = messages.at(-1);
	return {
		messages,
		cursor: encodeCursor(last ? last.seq : from),
		unread: countMessagesAfter(ctx.db, readCursorSeq(ctx.db, agent.id), { excludeAuthor: mine }),
		markedRead: markRead
	};
}

/**
 * How many messages one agent has not read (design §5).
 *
 * This is the count the heartbeat piggybacks, which is why it is deliberately
 * *not* filtered by project: an agent asks "is there anything for me", and an
 * answer scoped to somewhere it was not looking would be a no that means yes.
 */
export function countUnreadMessages(ctx: DomainContext, agentId: string): number {
	return countMessagesAfter(ctx.db, readCursorSeq(ctx.db, agentId), {
		excludeAuthor: authorText({ kind: 'agent', agentId })
	});
}

export type ThreadQuery = {
	/** One update's thread — what a card renders inline (design §7). */
	updateId?: string;
	/** One task's thread. */
	taskId?: string;
	/** A project slug or id: every message in it, its cards' threads included. */
	project?: string;
	/** Defaults to {@link MAX_MESSAGE_LIMIT}. */
	limit?: number;
};

/**
 * A thread as the owner's browser reads it: oldest first, newest kept.
 *
 * Unlike {@link readMessages} this has no cursor and no side effect — the owner
 * is looking at the page, not catching up through a tool — and it is the *newest*
 * messages that are kept when there are more than the cap allows, because the
 * bottom of a conversation is the part being read.
 *
 * Reaching that ordering costs a walk rather than a `DESC` query: `$db` reads
 * messages oldest first (a conversation is caught up on, not scrolled back
 * through), so a batch at a time is stepped through and only the last window is
 * kept. One query per `limit` rows, which at this product's scale (§1: one
 * owner, tens of agents) is a query or two.
 */
export function listThread(ctx: DomainContext, query: ThreadQuery): Message[] {
	const limit = pageLimit(query.limit ?? MAX_MESSAGE_LIMIT);
	const scope = {
		updateId: query.updateId,
		taskId: query.taskId,
		projectId: query.project ? resolveProject(ctx, query.project).id : undefined
	};

	let window: Message[] = [];
	let afterSeq = 0;
	for (;;) {
		const batch = listMessages(ctx.db, { ...scope, afterSeq, limit });
		if (batch.length === 0) return window;

		window = batch.length >= limit ? batch : [...window, ...batch].slice(-limit);
		if (batch.length < limit) return window;
		afterSeq = batch[batch.length - 1].seq;
	}
}

/**
 * How far this read may move the cursor.
 *
 * The plain answer is "to the last message handed over". The exception is the
 * point of this function: a read narrowed by a project, or started from an
 * explicit `since`, may have stepped over messages the agent has still never
 * seen, and the cursor may not pass those — the heartbeat's unread count is the
 * same comparison, so a cursor that jumped them would drop them silently.
 *
 * So when the read was narrowed, the earliest unread message it did *not* return
 * is looked up and the cursor stops just short of it. That costs one extra
 * indexed query, and only on a narrowed read.
 */
function readTo(
	ctx: DomainContext,
	args: {
		cursorSeq: number;
		from: number;
		mine: string;
		limit: number;
		projectId: string | undefined;
		messages: Message[];
	}
): number {
	const last = args.messages.at(-1)?.seq ?? args.from;
	const narrowed = args.projectId !== undefined || args.from !== args.cursorSeq;
	if (!narrowed) return last;

	// Everything unread, in order, up to the same page size. If the first `limit`
	// of those are exactly what was handed over, nothing was stepped over: the
	// two lists are the same rows.
	const unread = listMessages(ctx.db, {
		afterSeq: args.cursorSeq,
		excludeAuthor: args.mine,
		limit: args.limit
	});
	const handed = new Set(args.messages.map((message) => message.id));
	const skipped = unread.find((message) => !handed.has(message.id));

	return skipped ? Math.min(last, skipped.seq - 1) : last;
}

/** The author, checked: an agent that does not exist cannot have said anything. */
function assertAuthor(ctx: DomainContext, author: MessageAuthor): MessageAuthor {
	if (author.kind === 'human') return author;
	if (!findAgentById(ctx.db, author.agentId)) {
		throw notFound(`no such agent: ${author.agentId}`);
	}
	return author;
}

/**
 * The project an anchor puts a message in.
 *
 * A deleted update is `not_found` rather than a silent thread nobody can see: it
 * is gone from every timeline (design §3), so a reply on it would be written to
 * a card the owner can no longer read.
 */
function anchorProject(
	ctx: DomainContext,
	anchor: { updateId: string | null; taskId: string | null }
): string | null {
	if (anchor.updateId !== null) {
		const update = findUpdateById(ctx.db, anchor.updateId);
		if (!update || update.deletedAt !== null) throw notFound(`no such update: ${anchor.updateId}`);
		return update.projectId;
	}

	if (anchor.taskId !== null) {
		const task = findTaskById(ctx.db, anchor.taskId);
		if (!task) throw notFound(`no such task: ${anchor.taskId}`);
		return task.projectId;
	}

	return null;
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_MESSAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
	return Math.min(limit, MAX_MESSAGE_LIMIT);
}

/** Cursors are opaque to callers, which is why they are encoded and decoded here. */
function encodeCursor(seq: number): string {
	return String(seq);
}

function decodeCursor(cursor: string | null | undefined): number | undefined {
	if (cursor === undefined || cursor === null || cursor === '') return undefined;
	if (!/^[0-9]+$/.test(cursor)) throw invalid('since is not a cursor this server issued');
	return Number(cursor);
}
