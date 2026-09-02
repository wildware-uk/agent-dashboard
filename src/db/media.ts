/**
 * `media` (design §3, §6).
 *
 * Rows only: the disk layout, the mime allowlist and the derivative pipeline all
 * live in `src/media/`. Two shapes here exist because of the upload protocol —
 * a media row is created before its bytes arrive and before the update that
 * references it exists.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Media, MediaKind, MediaStatus } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	update_id: string | null;
	kind: MediaKind;
	mime: string;
	bytes: number;
	sha256: string;
	width: number | null;
	height: number | null;
	duration_ms: number | null;
	status: MediaStatus;
	created_at: number;
};

const COLUMNS = `seq, id, agent_id, update_id, kind, mime, bytes, sha256, width, height,
	duration_ms, status, created_at`;

function toMedia(row: Row): Media {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		updateId: row.update_id,
		kind: row.kind,
		mime: row.mime,
		bytes: row.bytes,
		sha256: row.sha256,
		width: row.width,
		height: row.height,
		durationMs: row.duration_ms,
		status: row.status,
		createdAt: row.created_at
	};
}

export type NewMedia = {
	id?: string;
	agentId: string;
	/** Usually null: the update that references this does not exist yet. */
	updateId?: string | null;
	kind: MediaKind;
	mime: string;
	bytes: number;
	sha256: string;
	width?: number | null;
	height?: number | null;
	durationMs?: number | null;
	status?: MediaStatus;
	createdAt?: number;
};

export function insertMedia(db: Db, input: NewMedia): Media {
	const row = {
		id: input.id ?? newId(),
		agent_id: input.agentId,
		update_id: orNull(input.updateId),
		kind: input.kind,
		mime: input.mime,
		bytes: input.bytes,
		sha256: input.sha256,
		width: orNull(input.width),
		height: orNull(input.height),
		duration_ms: orNull(input.durationMs),
		status: input.status ?? 'pending',
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO media
				(id, agent_id, update_id, kind, mime, bytes, sha256, width, height, duration_ms,
				 status, created_at)
			 VALUES
				(:id, :agent_id, :update_id, :kind, :mime, :bytes, :sha256, :width, :height,
				 :duration_ms, :status, :created_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toMedia(inserted);
}

export function findMediaById(db: Db, id: string): Media | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM media WHERE id = ?`).get(id);
	return row && toMedia(row);
}

/** Newest row with these bytes, for dedup. */
export function findMediaBySha256(db: Db, sha256: string): Media | undefined {
	const row = db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM media WHERE sha256 = ? ORDER BY seq DESC LIMIT 1`
		)
		.get(sha256);
	return row && toMedia(row);
}

/** The media on one update, in the order it was uploaded. */
export function listMediaForUpdate(db: Db, updateId: string): Media[] {
	return db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM media WHERE update_id = ? ORDER BY seq`)
		.all(updateId)
		.map(toMedia);
}

/**
 * Record the bytes that actually landed.
 *
 * Separate from {@link setMediaStatus} because it answers a different question.
 * A media row is inserted before its bytes exist, with the size the agent
 * *declared* and no hash at all; this is `src/media/`'s ingest writing down what
 * really arrived once it has streamed and hashed it. The status is deliberately
 * untouched: deciding a row is `ready` belongs to the derivative pipeline
 * (design §6 step 5), not to the upload.
 */
export function setMediaBytes(
	db: Db,
	id: string,
	input: { bytes: number; sha256: string }
): Media | undefined {
	const params = { id, bytes: input.bytes, sha256: input.sha256 };

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE media SET bytes = :bytes, sha256 = :sha256
			 WHERE id = :id
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toMedia(row);
}

export type MediaResult = {
	status: MediaStatus;
	width?: number | null;
	height?: number | null;
	durationMs?: number | null;
};

/**
 * Record the outcome of processing: `ready` with whatever was measured, or
 * `failed`. Dimensions absent from `result` are left as they were.
 */
export function setMediaStatus(db: Db, id: string, result: MediaResult): Media | undefined {
	const params = {
		id,
		status: result.status,
		width: orNull(result.width),
		height: orNull(result.height),
		duration_ms: orNull(result.durationMs)
	};

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE media SET
				status = :status,
				width = coalesce(:width, width),
				height = coalesce(:height, height),
				duration_ms = coalesce(:duration_ms, duration_ms)
			 WHERE id = :id
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toMedia(row);
}

/**
 * Point media rows at an update.
 *
 * Scoped to the owning agent and to media nothing has claimed yet, in one
 * statement: that is what stops one agent from decorating its post with another
 * agent's screenshots, without this layer knowing anything about why.
 *
 * @returns the ids actually attached, so a caller can report the rest as
 *   unavailable.
 */
export function attachMediaToUpdate(
	db: Db,
	options: { mediaIds: readonly string[]; updateId: string; agentId?: string }
): string[] {
	if (options.mediaIds.length === 0) return [];

	const placeholders = options.mediaIds.map(() => '?').join(', ');
	const params = [
		options.updateId,
		...options.mediaIds,
		options.agentId ?? null,
		options.agentId ?? null
	];

	return db
		.prepare<typeof params, { id: string }>(
			`UPDATE media SET update_id = ?
			 WHERE id IN (${placeholders})
			   AND update_id IS NULL
			   AND (? IS NULL OR agent_id = ?)
			 RETURNING id`
		)
		.all(...params)
		.map((row) => row.id);
}

/**
 * Media rows in one or more states, oldest first.
 *
 * The derivative pipeline's queue query (design §6 step 4): everything still
 * `pending` is work to do, and `hasBytes` excludes the reservations whose PUT
 * never happened, which have nothing to derive from. Bounded, because a
 * neglected deployment can have thousands and this runs on a timer inside the
 * process serving the dashboard.
 */
export function listMediaByStatus(
	db: Db,
	options: { statuses: readonly MediaStatus[]; hasBytes?: boolean; limit?: number }
): Media[] {
	if (options.statuses.length === 0) return [];

	const placeholders = options.statuses.map(() => '?').join(', ');
	const bytes = options.hasBytes ? `AND sha256 <> ''` : '';

	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM media
			 WHERE status IN (${placeholders}) ${bytes}
			 ORDER BY seq
			 LIMIT ?`
		)
		.all(...options.statuses, options.limit ?? 500)
		.map(toMedia);
}

/**
 * Media nothing points at any more, old enough to collect.
 *
 * "Orphaned" means no update *and* no project using it as a logo. The second
 * half is not obvious from the media table alone, which is exactly why it is
 * written into the query rather than left to the caller: a logo is media that by
 * design will never have an `update_id`, and a sweeper that only knew the first
 * half deleted every one of them an hour after it was set.
 */
export function listOrphanedMedia(
	db: Db,
	options: { createdBefore: number; statuses?: readonly MediaStatus[]; limit?: number }
): Media[] {
	const statuses = options.statuses ?? ['ready'];
	const placeholders = statuses.map(() => '?').join(', ');

	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM media
			 WHERE update_id IS NULL
			   AND status IN (${placeholders})
			   AND created_at < ?
			   -- A project logo is media nothing will ever attach to an update
			   -- (migration 006), so "no update" stopped meaning "nobody wants
			   -- this" the day logos existed. Without this clause the sweeper
			   -- collects every logo an hour after it is set, and the header goes
			   -- blank with nothing to say why.
			   AND id NOT IN (
				 SELECT json_extract(theme, '$.logoMediaId') FROM projects
				  WHERE theme IS NOT NULL AND json_extract(theme, '$.logoMediaId') IS NOT NULL
			   )
			 ORDER BY seq
			 LIMIT ?`
		)
		.all(...statuses, options.createdBefore, options.limit ?? 500)
		.map(toMedia);
}

/**
 * Hard delete: the bytes on disk are going too, so a soft delete would only
 * describe a file that is not there.
 */
export function deleteMedia(db: Db, id: string): boolean {
	return db.prepare(`DELETE FROM media WHERE id = ?`).run(id).changes === 1;
}
