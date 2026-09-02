/**
 * `messages` (design §3).
 *
 * A message can hang off a project, an update or a task, or none of them.
 * `author` is the literal `human` or `agent:<agent_id>` — this layer stores the
 * string and does not interpret it.
 *
 * Everything here reads oldest first: a message list is a conversation being
 * caught up on, not a timeline being scrolled back through.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Message } from './types';

type Row = {
	seq: number;
	id: string;
	project_id: string | null;
	update_id: string | null;
	task_id: string | null;
	author: string;
	body: string;
	created_at: number;
	reply_to: string | null;
	deleted_at: number | null;
	answers: string | null;
};

const COLUMNS = `seq, id, project_id, update_id, task_id, author, body, created_at, reply_to, deleted_at, answers`;

/**
 * The rule every read here keeps: a deleted message is gone.
 *
 * Written once, as a fragment, rather than remembered at each call site — a
 * query that forgot it would put an unsent line back in somebody's thread, and
 * that is exactly the kind of omission nobody notices until it is on screen.
 */
const LIVE = `deleted_at IS NULL`;

function toMessage(row: Row): Message {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		updateId: row.update_id,
		taskId: row.task_id,
		author: row.author,
		body: row.body,
		createdAt: row.created_at,
		replyTo: row.reply_to,
		deletedAt: row.deleted_at,
		answers: row.answers
	};
}

export type NewMessage = {
	id?: string;
	projectId?: string | null;
	updateId?: string | null;
	taskId?: string | null;
	/** `human`, or `agent:<agent_id>`. */
	author: string;
	body: string;
	createdAt?: number;
	/** The message this answers (migration 014). */
	replyTo?: string | null;
	/** The comment in the same thread this one is addressed to (migration 020). */
	answers?: string | null;
};

export function insertMessage(db: Db, input: NewMessage): Message {
	const row = {
		id: input.id ?? newId(),
		project_id: orNull(input.projectId),
		update_id: orNull(input.updateId),
		task_id: orNull(input.taskId),
		author: input.author,
		body: input.body,
		created_at: input.createdAt ?? Date.now(),
		reply_to: orNull(input.replyTo),
		answers: orNull(input.answers)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO messages
			   (id, project_id, update_id, task_id, author, body, created_at, reply_to, answers)
			 VALUES (:id, :project_id, :update_id, :task_id, :author, :body, :created_at, :reply_to, :answers)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toMessage(inserted);
}

/**
 * One message, deleted or not.
 *
 * Unfiltered on purpose, unlike every list here: a caller that has an id is
 * asking about that row, and deleting something twice has to be answerable
 * without a second query. Callers that must not act on a deleted message check
 * `deletedAt`, which is the same shape `findUpdateById` keeps.
 */
export function findMessageById(db: Db, id: string): Message | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id);
	return row && toMessage(row);
}

/**
 * Soft delete.
 *
 * @returns whether this call was the one that deleted it, so only the first
 *   caller publishes `message.deleted`.
 */
export function softDeleteMessage(db: Db, id: string, at: number = Date.now()): boolean {
	return (
		db
			.prepare<[number, string]>(`UPDATE messages SET deleted_at = ? WHERE id = ? AND ${LIVE}`)
			.run(at, id).changes > 0
	);
}

/**
 * The live replies under one message.
 *
 * Deleting a post takes its replies with it — a thread hanging under a line
 * nobody can read is not a conversation — so the caller needs to know what they
 * are.
 */
export function listRepliesTo(db: Db, messageId: string): Message[] {
	return db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM messages WHERE reply_to = ? AND ${LIVE} ORDER BY seq ASC`
		)
		.all(messageId)
		.map(toMessage);
}

export type MessageQuery = {
	projectId?: string;
	/**
	 * Any of these projects, for a reader scoped to a subscription.
	 *
	 * Separate from `projectId` because it has to be applied **in the query**: a
	 * caller that took a page and then filtered it in memory would get an empty
	 * page whenever the first N unread happened to be somewhere else, which is
	 * exactly how the channel went silent (see `unreadMessagesInScope`).
	 *
	 * An empty list matches nothing, never everything — "these projects" with
	 * none named is none.
	 */
	projectIds?: readonly string[];
	updateId?: string;
	taskId?: string;
	/** Everything newer than this seq: the read cursor's companion. */
	afterSeq?: number;
	/** Ignore messages by this author, typically the reader's own. */
	excludeAuthor?: string;
	/** Default 100. */
	limit?: number;
	/**
	 * Take the *newest* rows rather than the oldest.
	 *
	 * Reading a conversation means oldest first, which is why that is the
	 * default. Announcing one does not: a notification is about what just
	 * arrived, and taking the oldest of a long unread list means the newest
	 * message never reaches the window at all — which is exactly how new
	 * messages stopped being announced while five old ones were repeated.
	 *
	 * The rows still come back oldest first; only which ones are chosen changes.
	 */
	newest?: boolean;
};

/** Messages oldest first. */
export function listMessages(db: Db, query: MessageQuery = {}): Message[] {
	// An empty subscription matches nothing rather than everything.
	if (query.projectIds?.length === 0) return [];

	const scope = query.projectIds
		? `AND project_id IN (${query.projectIds.map(() => '?').join(', ')})`
		: '';
	const params = [
		orNull(query.projectId),
		orNull(query.projectId),
		orNull(query.updateId),
		orNull(query.updateId),
		orNull(query.taskId),
		orNull(query.taskId),
		orNull(query.afterSeq),
		orNull(query.afterSeq),
		orNull(query.excludeAuthor),
		orNull(query.excludeAuthor),
		...(query.projectIds ?? []),
		query.limit ?? 100
	];

	const rows = db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM messages
			 WHERE (? IS NULL OR project_id = ?)
			   AND (? IS NULL OR update_id = ?)
			   AND (? IS NULL OR task_id = ?)
			   AND (? IS NULL OR seq > ?)
			   AND (? IS NULL OR author <> ?)
			   AND ${LIVE}
			   ${scope}
			 ORDER BY seq ${query.newest ? 'DESC' : 'ASC'}
			 LIMIT ?`
		)
		.all(...params)
		.map(toMessage);

	// Chosen newest-first, read oldest-first: a caller wanting the latest few
	// still wants them in the order they were said.
	return query.newest ? rows.reverse() : rows;
}

/**
 * How many messages sit after a cursor: the unread count the heartbeat carries
 * back to an agent (design §5).
 */
export function countMessagesAfter(
	db: Db,
	afterSeq: number,
	query: { projectId?: string; projectIds?: readonly string[]; excludeAuthor?: string } = {}
): number {
	const params: Record<string, unknown> = {
		after_seq: afterSeq,
		project_id: orNull(query.projectId),
		exclude_author: orNull(query.excludeAuthor)
	};

	// An explicit list of projects, for a caller that wants "anything in the
	// places this agent works" rather than one project or all of them. Expanded
	// into placeholders because SQLite has no array parameter; an empty list is
	// not the same as an absent one and is answered without a query at all,
	// since `IN ()` is a syntax error and would otherwise mean "match nothing"
	// written as a crash.
	let scope = '';
	if (query.projectIds) {
		if (query.projectIds.length === 0) return 0;
		scope = ` AND project_id IN (${query.projectIds.map((_, index) => `:p${index}`).join(', ')})`;
		query.projectIds.forEach((id, index) => (params[`p${index}`] = id));
	}

	return db
		.prepare<typeof params, { n: number }>(
			`SELECT count(*) AS n FROM messages
			 WHERE seq > :after_seq
			   AND ${LIVE}
			   AND (:project_id IS NULL OR project_id = :project_id)
			   AND (:exclude_author IS NULL OR author <> :exclude_author)${scope}`
		)
		.get(params)!.n;
}

/**
 * Every project one agent has anything to do with.
 *
 * There is no "assignment" in this product — an agent is not a member of a
 * project, it just works in one — so relevance is derived from what it has
 * actually done: posted an update, been handed a task, or spoken in a thread.
 * That is the honest answer to "should this agent be woken for this project",
 * and it needs no configuration anybody could forget to set.
 *
 * An empty list means an agent that has done nothing yet, which callers treat
 * as "hears everything" rather than "hears nothing": a brand new agent must not
 * be deaf to the first message ever sent to it.
 */
export function listAgentProjectIds(db: Db, agentId: string, author: string): string[] {
	const params = { agent_id: agentId, author };
	return db
		.prepare<typeof params, { project_id: string }>(
			`SELECT DISTINCT project_id FROM updates WHERE agent_id = :agent_id
			 UNION
			 SELECT DISTINCT project_id FROM tasks
			  WHERE agent_id = :agent_id AND project_id IS NOT NULL
			 UNION
			 SELECT DISTINCT project_id FROM messages
			  WHERE author = :author AND project_id IS NOT NULL AND ${LIVE}`
		)
		.all(params)
		.map((row) => row.project_id);
}
