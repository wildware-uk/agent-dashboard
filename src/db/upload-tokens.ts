/**
 * `upload_tokens` (design §6).
 *
 * A token is minted per upload, single use, with its own byte cap and mime
 * allowlist. The HMAC signing lives in `src/media/`; what lives here is the
 * atomic spend — `consumeUploadToken` is a single conditional UPDATE, so two
 * concurrent PUTs with the same token cannot both be let through.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { jsonOf, jsonText } from './rows';
import type { UploadToken } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	media_id: string;
	max_bytes: number;
	mime_allow: string;
	expires_at: number;
	used_at: number | null;
};

const COLUMNS = `seq, id, agent_id, media_id, max_bytes, mime_allow, expires_at, used_at`;

function toUploadToken(row: Row): UploadToken {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		mediaId: row.media_id,
		maxBytes: row.max_bytes,
		mimeAllow: jsonOf<string[]>(row.mime_allow) ?? [],
		expiresAt: row.expires_at,
		usedAt: row.used_at
	};
}

export type NewUploadToken = {
	id?: string;
	agentId: string;
	mediaId: string;
	maxBytes: number;
	mimeAllow: readonly string[];
	expiresAt: number;
};

export function insertUploadToken(db: Db, input: NewUploadToken): UploadToken {
	const row = {
		id: input.id ?? newId(),
		agent_id: input.agentId,
		media_id: input.mediaId,
		max_bytes: input.maxBytes,
		mime_allow: jsonText([...input.mimeAllow])!,
		expires_at: input.expiresAt
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO upload_tokens (id, agent_id, media_id, max_bytes, mime_allow, expires_at)
			 VALUES (:id, :agent_id, :media_id, :max_bytes, :mime_allow, :expires_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toUploadToken(inserted);
}

export function findUploadTokenById(db: Db, id: string): UploadToken | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM upload_tokens WHERE id = ?`)
		.get(id);
	return row && toUploadToken(row);
}

/**
 * Spend a token.
 *
 * @returns the token as spent, or `undefined` if it does not exist, has already
 *   been used, or has expired — one atomic statement, so the winner of a race is
 *   the only caller that gets a row back.
 */
export function consumeUploadToken(
	db: Db,
	id: string,
	options: { now?: number } = {}
): UploadToken | undefined {
	const now = options.now ?? Date.now();

	const row = db
		.prepare<[number, string, number], Row>(
			`UPDATE upload_tokens SET used_at = ?
			 WHERE id = ? AND used_at IS NULL AND expires_at > ?
			 RETURNING ${COLUMNS}`
		)
		.get(now, id, now);

	return row && toUploadToken(row);
}

/**
 * Drop unused tokens past their expiry. Spent tokens stay: they are the record
 * that an upload happened.
 */
export function deleteExpiredUploadTokens(db: Db, now: number = Date.now()): number {
	return db.prepare(`DELETE FROM upload_tokens WHERE used_at IS NULL AND expires_at <= ?`).run(now)
		.changes;
}
