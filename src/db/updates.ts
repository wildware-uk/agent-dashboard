/**
 * `updates` (design §3).
 *
 * The timeline table. Two things here earn their keep:
 *
 * - `seq` cursors rather than offsets, so a page stays correct while new updates
 *   arrive at the top.
 * - soft delete, so a browser that has already rendered a row can be told to
 *   drop it instead of silently disagreeing with the server.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { boolOf, flagOf, orNull } from './rows';
import type { Update, UpdateLevel, UpdatePriority } from './types';

type Row = {
	seq: number;
	id: string;
	project_id: string;
	agent_id: string;
	session_id: string | null;
	title: string | null;
	body: string;
	level: UpdateLevel;
	pinned: number;
	created_at: number;
	deleted_at: number | null;
	edited_at: number | null;
	priority: UpdatePriority;
	task_id: string | null;
	replies_seen_at: number | null;
};

const COLUMNS = `seq, id, project_id, agent_id, session_id, title, body, level, pinned,
	created_at, deleted_at, edited_at, priority, task_id, replies_seen_at`;

function toUpdate(row: Row): Update {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		agentId: row.agent_id,
		sessionId: row.session_id,
		title: row.title,
		body: row.body,
		level: row.level,
		pinned: boolOf(row.pinned),
		createdAt: row.created_at,
		deletedAt: row.deleted_at,
		editedAt: row.edited_at,
		priority: row.priority,
		taskId: row.task_id,
		repliesSeenAt: row.replies_seen_at
	};
}

export type NewUpdate = {
	id?: string;
	projectId: string;
	agentId: string;
	sessionId?: string | null;
	title?: string | null;
	/** Markdown as the agent wrote it. Sanitising is the renderer's job. */
	body: string;
	level?: UpdateLevel;
	priority?: UpdatePriority;
	pinned?: boolean;
	createdAt?: number;
	/** The task this is progress on. Most updates have none (migration 008). */
	taskId?: string | null;
};

export function insertUpdate(db: Db, input: NewUpdate): Update {
	const row = {
		id: input.id ?? newId(),
		project_id: input.projectId,
		agent_id: input.agentId,
		session_id: orNull(input.sessionId),
		title: orNull(input.title),
		body: input.body,
		level: input.level ?? 'info',
		priority: input.priority ?? 'medium',
		task_id: orNull(input.taskId),
		pinned: flagOf(input.pinned ?? false),
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO updates
				(id, project_id, agent_id, session_id, title, body, level, priority, task_id,
				 pinned, created_at)
			 VALUES
				(:id, :project_id, :agent_id, :session_id, :title, :body, :level, :priority,
				 :task_id, :pinned, :created_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toUpdate(inserted);
}

export function findUpdateById(db: Db, id: string): Update | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM updates WHERE id = ?`).get(id);
	return row && toUpdate(row);
}

export type UpdateQuery = {
	projectId?: string;
	agentId?: string;
	/** Only updates filed against this task (migration 008). */
	taskId?: string;
	/** Older than this seq: the next page down the timeline. */
	beforeSeq?: number;
	/** Newer than this seq: catching up after a gap. */
	afterSeq?: number;
	/** Default 50. */
	limit?: number;
	includeDeleted?: boolean;
};

/** The timeline, newest first. */
export function listUpdates(db: Db, query: UpdateQuery = {}): Update[] {
	const params = {
		project_id: orNull(query.projectId),
		agent_id: orNull(query.agentId),
		task_id: orNull(query.taskId),
		before_seq: orNull(query.beforeSeq),
		after_seq: orNull(query.afterSeq),
		limit: query.limit ?? 50,
		include_deleted: query.includeDeleted ? 1 : 0
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM updates
			 WHERE (:project_id IS NULL OR project_id = :project_id)
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			   AND (:task_id IS NULL OR task_id = :task_id)
			   AND (:before_seq IS NULL OR seq < :before_seq)
			   AND (:after_seq IS NULL OR seq > :after_seq)
			   AND (:include_deleted = 1 OR deleted_at IS NULL)
			 ORDER BY seq DESC
			 LIMIT :limit`
		)
		.all(params)
		.map(toUpdate);
}

/**
 * Soft delete.
 *
 * @returns whether this call was the one that deleted it, so only the first
 *   caller publishes `update.deleted`.
 */
export function softDeleteUpdate(db: Db, id: string, at: number = Date.now()): boolean {
	const result = db
		.prepare(`UPDATE updates SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
		.run(at, id);

	return result.changes === 1;
}

/** The fields an agent may correct on its own update. Absent means "leave it". */
export type UpdateEdit = {
	title?: string | null;
	body?: string;
	level?: UpdateLevel;
	priority?: UpdatePriority;
	editedAt: number;
};

/**
 * Rewrite an update's own content, stamping when.
 *
 * Only ever the three fields an agent authored: not `created_at` (the timeline
 * would reorder under the reader), not `pinned` (the owner's, not the agent's),
 * and not `project_id` (an update that changed project would vanish from one
 * timeline and appear in another with no event able to describe it).
 *
 * A live row only: `deleted_at IS NULL` is in the statement rather than checked
 * before it, so editing a deleted update cannot resurrect its text.
 */
export function editUpdate(db: Db, id: string, edit: UpdateEdit): Update | undefined {
	const sets: string[] = ['edited_at = :edited_at'];
	const params: Record<string, string | number | null> = { id, edited_at: edit.editedAt };

	if (edit.title !== undefined) {
		sets.push('title = :title');
		params.title = orNull(edit.title);
	}
	if (edit.body !== undefined) {
		sets.push('body = :body');
		params.body = edit.body;
	}
	if (edit.level !== undefined) {
		sets.push('level = :level');
		params.level = edit.level;
	}
	if (edit.priority !== undefined) {
		sets.push('priority = :priority');
		params.priority = edit.priority;
	}

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE updates SET ${sets.join(', ')}
			 WHERE id = :id AND deleted_at IS NULL
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toUpdate(row);
}

export function setUpdatePinned(db: Db, id: string, pinned: boolean): Update | undefined {
	const row = db
		.prepare<[0 | 1, string], Row>(
			`UPDATE updates SET pinned = ? WHERE id = ? RETURNING ${COLUMNS}`
		)
		.get(flagOf(pinned), id);

	return row && toUpdate(row);
}

/**
 * Stamp when the owner last read the conversation on one card.
 *
 * Deliberately not part of {@link editUpdate} or {@link setUpdatePinned}: those
 * change what the card *is* and belong to whoever wrote it. Reading its replies
 * changes nothing about the card and is nobody's business but the owner's.
 */
export function markRepliesSeen(db: Db, id: string, at: number): Update | undefined {
	const row = db
		.prepare<[number, string], Row>(
			`UPDATE updates SET replies_seen_at = ?
			 WHERE id = ? AND deleted_at IS NULL
			 RETURNING ${COLUMNS}`
		)
		.get(at, id);

	return row && toUpdate(row);
}
