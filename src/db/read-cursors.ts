/**
 * `read_cursors` (design §3).
 *
 * One row per reader **per project**, holding the last message seq that reader
 * has seen there. Unread state is a cursor rather than a flag on `messages` so
 * a second reader is a row, not a schema change.
 *
 * Per project since migration 025. One number per agent could not be right for
 * an owner whose sessions share a token: a session reading its own project
 * moved the only cursor there was, and the messages it stepped over in another
 * project became unannounceable. See that migration for the whole story.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { ReadCursor } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	project_id: string;
	last_seen_message_seq: number;
};

const COLUMNS = `seq, id, agent_id, project_id, last_seen_message_seq`;

/**
 * The bucket for messages that belong to no project.
 *
 * A message can hang off nothing at all, and it still has to be readable and
 * markable. An empty string rather than NULL because the unique key is an
 * upsert target, and SQLite counts two NULLs as different values.
 */
export const NO_PROJECT = '';

function toReadCursor(row: Row): ReadCursor {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		projectId: row.project_id,
		lastSeenMessageSeq: row.last_seen_message_seq
	};
}

export function getReadCursor(
	db: Db,
	agentId: string,
	projectId: string = NO_PROJECT
): ReadCursor | undefined {
	const row = db
		.prepare<[string, string], Row>(
			`SELECT ${COLUMNS} FROM read_cursors WHERE agent_id = ? AND project_id = ?`
		)
		.get(agentId, projectId);
	return row && toReadCursor(row);
}

/** The agent's cursor in one project, or 0 where it has never read anything. */
export function readCursorSeq(db: Db, agentId: string, projectId: string = NO_PROJECT): number {
	return getReadCursor(db, agentId, projectId)?.lastSeenMessageSeq ?? 0;
}

/** Every cursor one agent holds, for a caller reading across projects. */
export function listReadCursors(db: Db, agentId: string): ReadCursor[] {
	return db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM read_cursors WHERE agent_id = ? ORDER BY seq`)
		.all(agentId)
		.map(toReadCursor);
}

/**
 * Move a reader's cursor in one project forward, creating it if this is its
 * first read there.
 *
 * `max` rather than a plain assignment: two overlapping `get_messages` calls can
 * finish out of order, and the older one must not un-read the newer one's
 * messages.
 */
export function advanceReadCursor(
	db: Db,
	agentId: string,
	projectId: string,
	lastSeenSeq: number
): ReadCursor {
	const params = {
		id: newId(),
		agent_id: agentId,
		project_id: projectId,
		seq: lastSeenSeq
	};

	const row = db
		.prepare<typeof params, Row>(
			`INSERT INTO read_cursors (id, agent_id, project_id, last_seen_message_seq)
			 VALUES (:id, :agent_id, :project_id, :seq)
			 ON CONFLICT (agent_id, project_id) DO UPDATE SET
				last_seen_message_seq = max(last_seen_message_seq, excluded.last_seen_message_seq)
			 RETURNING ${COLUMNS}`
		)
		.get(params)!;

	return toReadCursor(row);
}
