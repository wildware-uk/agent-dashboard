/**
 * The `update_shares` repository (design §7, §8).
 *
 * Statements over one table. Whether a share may be created, what a public
 * visitor is allowed to see through it, and what a revoked one means are all
 * `src/domain/shares.ts`'s decisions — this module only ever answers "what is in
 * the row".
 */
import type { Db } from './connection';
import { newId } from './ids';

/** One public link to one update. The token itself is never stored (see 005). */
export type UpdateShare = {
	id: string;
	seq: number;
	updateId: string;
	/** HMAC-SHA256 of the token. The token is shown once and never kept. */
	tokenHash: string;
	createdAt: number;
	/** When the owner switched it off, or `null` while it still works. */
	revokedAt: number | null;
	views: number;
	lastViewedAt: number | null;
};

type Row = {
	id: string;
	seq: number;
	update_id: string;
	token_hash: string;
	created_at: number;
	revoked_at: number | null;
	views: number;
	last_viewed_at: number | null;
};

const COLUMNS = 'seq, id, update_id, token_hash, created_at, revoked_at, views, last_viewed_at';

function toShare(row: Row): UpdateShare {
	return {
		id: row.id,
		seq: row.seq,
		updateId: row.update_id,
		tokenHash: row.token_hash,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
		views: row.views,
		lastViewedAt: row.last_viewed_at
	};
}

export type NewUpdateShare = {
	id?: string;
	updateId: string;
	tokenHash: string;
	createdAt?: number;
};

/**
 * Store a share.
 *
 * The partial unique index from migration 005 means this throws if the update
 * already has a live share, which is the point: the domain revokes the old one
 * first, and a caller that forgets gets an error rather than a second link
 * nobody knows to revoke.
 */
export function insertUpdateShare(db: Db, input: NewUpdateShare): UpdateShare {
	const row = {
		id: input.id ?? newId(),
		update_id: input.updateId,
		token_hash: input.tokenHash,
		created_at: input.createdAt ?? Date.now()
	};

	const saved = db
		.prepare<typeof row, Row>(
			`INSERT INTO update_shares (id, update_id, token_hash, created_at)
			 VALUES (:id, :update_id, :token_hash, :created_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row);

	return toShare(saved!);
}

/**
 * The share a token names, revoked or not.
 *
 * Revoked rows are returned rather than filtered out here, so the domain can
 * tell "this link was switched off" from "this link never existed" — even though
 * both are answered the same way to a visitor.
 */
export function findShareByTokenHash(db: Db, tokenHash: string): UpdateShare | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM update_shares WHERE token_hash = ?`)
		.get(tokenHash);
	return row && toShare(row);
}

export function findShareById(db: Db, id: string): UpdateShare | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM update_shares WHERE id = ?`)
		.get(id);
	return row && toShare(row);
}

/** The live share on this update, if it has one. */
export function findLiveShareForUpdate(db: Db, updateId: string): UpdateShare | undefined {
	const row = db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM update_shares
			 WHERE update_id = ? AND revoked_at IS NULL`
		)
		.get(updateId);
	return row && toShare(row);
}

/**
 * Switch off whatever live share this update has.
 *
 * @returns whether a live share was actually switched off, so a caller can be
 *   idempotent without reading first.
 */
export function revokeSharesForUpdate(db: Db, updateId: string, at: number = Date.now()): boolean {
	return (
		db
			.prepare<[number, string]>(
				`UPDATE update_shares SET revoked_at = ?
				 WHERE update_id = ? AND revoked_at IS NULL`
			)
			.run(at, updateId).changes > 0
	);
}

/** Count one public read, so the owner can see a link is being used. */
export function recordShareView(db: Db, id: string, at: number = Date.now()): void {
	db.prepare<[number, string]>(
		`UPDATE update_shares SET views = views + 1, last_viewed_at = ? WHERE id = ?`
	).run(at, id);
}

/** Every share ever made for one update, newest first. */
export function listSharesForUpdate(db: Db, updateId: string): UpdateShare[] {
	return db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM update_shares WHERE update_id = ? ORDER BY seq DESC`
		)
		.all(updateId)
		.map(toShare);
}
