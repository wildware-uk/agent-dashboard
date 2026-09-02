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
};

const COLUMNS = `seq, id, project_id, update_id, task_id, author, body, created_at, reply_to`;

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
		replyTo: row.reply_to
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
		reply_to: orNull(input.replyTo)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO messages (id, project_id, update_id, task_id, author, body, created_at, reply_to)
			 VALUES (:id, :project_id, :update_id, :task_id, :author, :body, :created_at, :reply_to)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toMessage(inserted);
}

export function findMessageById(db: Db, id: string): Message | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id);
	return row && toMessage(row);
}

export type MessageQuery = {
	projectId?: string;
	updateId?: string;
	taskId?: string;
	/** Everything newer than this seq: the read cursor's companion. */
	afterSeq?: number;
	/** Ignore messages by this author, typically the reader's own. */
	excludeAuthor?: string;
	/** Default 100. */
	limit?: number;
};

/** Messages oldest first. */
export function listMessages(db: Db, query: MessageQuery = {}): Message[] {
	const params = {
		project_id: orNull(query.projectId),
		update_id: orNull(query.updateId),
		task_id: orNull(query.taskId),
		after_seq: orNull(query.afterSeq),
		exclude_author: orNull(query.excludeAuthor),
		limit: query.limit ?? 100
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM messages
			 WHERE (:project_id IS NULL OR project_id = :project_id)
			   AND (:update_id IS NULL OR update_id = :update_id)
			   AND (:task_id IS NULL OR task_id = :task_id)
			   AND (:after_seq IS NULL OR seq > :after_seq)
			   AND (:exclude_author IS NULL OR author <> :exclude_author)
			 ORDER BY seq
			 LIMIT :limit`
		)
		.all(params)
		.map(toMessage);
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
			  WHERE author = :author AND project_id IS NOT NULL`
		)
		.all(params)
		.map((row) => row.project_id);
}
