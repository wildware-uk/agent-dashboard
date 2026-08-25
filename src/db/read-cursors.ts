/**
 * `read_cursors` (design §3).
 *
 * One row per reader, holding the last message seq it has seen. Unread state is
 * a cursor rather than a flag on `messages` so a second reader is a row, not a
 * schema change.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { ReadCursor } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	last_seen_message_seq: number;
};

const COLUMNS = `seq, id, agent_id, last_seen_message_seq`;

function toReadCursor(row: Row): ReadCursor {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		lastSeenMessageSeq: row.last_seen_message_seq
	};
}

export function getReadCursor(db: Db, agentId: string): ReadCursor | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM read_cursors WHERE agent_id = ?`)
		.get(agentId);
	return row && toReadCursor(row);
}

/** The agent's cursor, or 0 when it has never read anything. */
export function readCursorSeq(db: Db, agentId: string): number {
	return getReadCursor(db, agentId)?.lastSeenMessageSeq ?? 0;
}

/**
 * Move a reader's cursor forward, creating it if this is its first read.
 *
 * `max` rather than a plain assignment: two overlapping `get_messages` calls can
 * finish out of order, and the older one must not un-read the newer one's
 * messages.
 */
export function advanceReadCursor(db: Db, agentId: string, lastSeenSeq: number): ReadCursor {
	const params = { id: newId(), agent_id: agentId, seq: lastSeenSeq };

	const row = db
		.prepare<typeof params, Row>(
			`INSERT INTO read_cursors (id, agent_id, last_seen_message_seq)
			 VALUES (:id, :agent_id, :seq)
			 ON CONFLICT (agent_id) DO UPDATE SET
				last_seen_message_seq = max(last_seen_message_seq, excluded.last_seen_message_seq)
			 RETURNING ${COLUMNS}`
		)
		.get(params)!;

	return toReadCursor(row);
}
