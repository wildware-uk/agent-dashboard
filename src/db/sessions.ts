/**
 * `sessions` (design §3, §4).
 *
 * Presence is derived from these rows, never stored as a flag: an agent is
 * online when one of its sessions has beaten recently. That is why the queries
 * here take their cutoff and their clock as arguments — the policy (90 seconds
 * live, 10 minutes stale) belongs to the domain.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { jsonOf, jsonText } from './rows';
import type { Session, SessionMeta } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	started_at: number;
	last_heartbeat_at: number;
	ended_at: number | null;
	meta: string | null;
};

const COLUMNS = `seq, id, agent_id, started_at, last_heartbeat_at, ended_at, meta`;

function toSession(row: Row): Session {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		startedAt: row.started_at,
		lastHeartbeatAt: row.last_heartbeat_at,
		endedAt: row.ended_at,
		meta: jsonOf<SessionMeta>(row.meta)
	};
}

export type NewSession = {
	id?: string;
	agentId: string;
	startedAt?: number;
	/** Defaults to `startedAt`: registering is itself the first heartbeat. */
	lastHeartbeatAt?: number;
	meta?: SessionMeta | null;
};

export function insertSession(db: Db, input: NewSession): Session {
	const startedAt = input.startedAt ?? Date.now();
	const row = {
		id: input.id ?? newId(),
		agent_id: input.agentId,
		started_at: startedAt,
		last_heartbeat_at: input.lastHeartbeatAt ?? startedAt,
		meta: jsonText(input.meta)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO sessions (id, agent_id, started_at, last_heartbeat_at, meta)
			 VALUES (:id, :agent_id, :started_at, :last_heartbeat_at, :meta)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toSession(inserted);
}

export function findSessionById(db: Db, id: string): Session | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id);
	return row && toSession(row);
}

/**
 * Record a heartbeat.
 *
 * @returns `false` when there is no such open session, which is how a caller
 *   learns its session was swept out from under it and it should register again.
 */
export function heartbeatSession(db: Db, id: string, at: number = Date.now()): boolean {
	const result = db
		.prepare(
			`UPDATE sessions SET last_heartbeat_at = ?
			 WHERE id = ? AND ended_at IS NULL`
		)
		.run(at, id);

	return result.changes === 1;
}

/** Close a session. @returns whether this call was the one that closed it. */
export function endSession(db: Db, id: string, at: number = Date.now()): boolean {
	const result = db
		.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
		.run(at, id);

	return result.changes === 1;
}

/** Open sessions that have beaten at or after `since`. The presence query. */
export function listLiveSessions(db: Db, since: number): Session[] {
	return db
		.prepare<[number], Row>(
			`SELECT ${COLUMNS} FROM sessions
			 WHERE ended_at IS NULL AND last_heartbeat_at >= ?
			 ORDER BY last_heartbeat_at DESC`
		)
		.all(since)
		.map(toSession);
}

export function listSessionsForAgent(
	db: Db,
	agentId: string,
	filter: { openOnly?: boolean } = {}
): Session[] {
	return db
		.prepare<{ agent_id: string; open_only: 0 | 1 }, Row>(
			`SELECT ${COLUMNS} FROM sessions
			 WHERE agent_id = :agent_id AND (:open_only = 0 OR ended_at IS NULL)
			 ORDER BY seq DESC`
		)
		.all({ agent_id: agentId, open_only: filter.openOnly ? 1 : 0 })
		.map(toSession);
}

/**
 * Close every open session whose last heartbeat is older than `idleBefore`.
 *
 * @returns the ids it closed, so the caller can publish presence for exactly
 *   those agents rather than re-deriving the set.
 */
export function endStaleSessions(db: Db, options: { idleBefore: number; at?: number }): string[] {
	return db
		.prepare<{ idle_before: number; at: number }, { id: string }>(
			`UPDATE sessions SET ended_at = :at
			 WHERE ended_at IS NULL AND last_heartbeat_at < :idle_before
			 RETURNING id`
		)
		.all({ idle_before: options.idleBefore, at: options.at ?? Date.now() })
		.map((row) => row.id);
}
