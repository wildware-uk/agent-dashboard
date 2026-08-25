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
import type { Update, UpdateLevel } from './types';

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
};

const COLUMNS = `seq, id, project_id, agent_id, session_id, title, body, level, pinned,
	created_at, deleted_at`;

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
		deletedAt: row.deleted_at
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
	pinned?: boolean;
	createdAt?: number;
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
		pinned: flagOf(input.pinned ?? false),
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO updates
				(id, project_id, agent_id, session_id, title, body, level, pinned, created_at)
			 VALUES
				(:id, :project_id, :agent_id, :session_id, :title, :body, :level, :pinned, :created_at)
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

export function setUpdatePinned(db: Db, id: string, pinned: boolean): Update | undefined {
	const row = db
		.prepare<[0 | 1, string], Row>(
			`UPDATE updates SET pinned = ? WHERE id = ? RETURNING ${COLUMNS}`
		)
		.get(flagOf(pinned), id);

	return row && toUpdate(row);
}
