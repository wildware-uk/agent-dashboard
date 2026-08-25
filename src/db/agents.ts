/**
 * `agents` (design §3, §8).
 *
 * An agent row holds the HMAC of its bearer token, never the token itself, and
 * `findAgentByTokenHash` is how every MCP call resolves its caller. Hashing and
 * constant-time comparison happen above this layer.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { Agent } from './types';

type Row = {
	seq: number;
	id: string;
	name: string;
	token_hash: string;
	created_at: number;
	revoked_at: number | null;
	last_seen_at: number | null;
};

const COLUMNS = `seq, id, name, token_hash, created_at, revoked_at, last_seen_at`;

function toAgent(row: Row): Agent {
	return {
		seq: row.seq,
		id: row.id,
		name: row.name,
		tokenHash: row.token_hash,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
		lastSeenAt: row.last_seen_at
	};
}

export type NewAgent = {
	id?: string;
	name: string;
	/** HMAC-SHA256 of the minted token under `TOKEN_SECRET`. */
	tokenHash: string;
	createdAt?: number;
};

export function insertAgent(db: Db, input: NewAgent): Agent {
	const row = {
		id: input.id ?? newId(),
		name: input.name,
		token_hash: input.tokenHash,
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO agents (id, name, token_hash, created_at)
			 VALUES (:id, :name, :token_hash, :created_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toAgent(inserted);
}

export function findAgentById(db: Db, id: string): Agent | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM agents WHERE id = ?`).get(id);
	return row && toAgent(row);
}

/**
 * Resolve a token hash to its agent.
 *
 * Revoked agents are returned too: the caller decides whether to answer "no such
 * token" or "that token was revoked", which is a policy question, not a query.
 */
export function findAgentByTokenHash(db: Db, tokenHash: string): Agent | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM agents WHERE token_hash = ?`)
		.get(tokenHash);
	return row && toAgent(row);
}

export function listAgents(db: Db, filter: { includeRevoked?: boolean } = {}): Agent[] {
	const rows = db
		.prepare<{ include: 0 | 1 }, Row>(
			`SELECT ${COLUMNS} FROM agents
			 WHERE (:include = 1 OR revoked_at IS NULL)
			 ORDER BY seq`
		)
		.all({ include: filter.includeRevoked ? 1 : 0 });

	return rows.map(toAgent);
}

/**
 * Revoke an agent's token.
 *
 * @returns whether this call was the one that revoked it, so a caller can tell a
 *   revocation from a repeat.
 */
export function revokeAgent(db: Db, id: string, at: number = Date.now()): boolean {
	const result = db
		.prepare(`UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
		.run(at, id);

	return result.changes === 1;
}

/**
 * Record that the agent was heard from.
 *
 * Never moves backwards: heartbeats and tool calls interleave, and an older
 * timestamp arriving late must not make a live agent look stale.
 */
export function touchAgent(db: Db, id: string, at: number = Date.now()): boolean {
	const result = db
		.prepare(
			`UPDATE agents SET last_seen_at = max(coalesce(last_seen_at, 0), ?)
			 WHERE id = ?`
		)
		.run(at, id);

	return result.changes === 1;
}
