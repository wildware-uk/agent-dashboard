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
};

const COLUMNS = `seq, id, project_id, update_id, task_id, author, body, created_at`;

function toMessage(row: Row): Message {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		updateId: row.update_id,
		taskId: row.task_id,
		author: row.author,
		body: row.body,
		createdAt: row.created_at
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
};

export function insertMessage(db: Db, input: NewMessage): Message {
	const row = {
		id: input.id ?? newId(),
		project_id: orNull(input.projectId),
		update_id: orNull(input.updateId),
		task_id: orNull(input.taskId),
		author: input.author,
		body: input.body,
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO messages (id, project_id, update_id, task_id, author, body, created_at)
			 VALUES (:id, :project_id, :update_id, :task_id, :author, :body, :created_at)
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
	query: { projectId?: string; excludeAuthor?: string } = {}
): number {
	const params = {
		after_seq: afterSeq,
		project_id: orNull(query.projectId),
		exclude_author: orNull(query.excludeAuthor)
	};

	return db
		.prepare<typeof params, { n: number }>(
			`SELECT count(*) AS n FROM messages
			 WHERE seq > :after_seq
			   AND (:project_id IS NULL OR project_id = :project_id)
			   AND (:exclude_author IS NULL OR author <> :exclude_author)`
		)
		.get(params)!.n;
}
