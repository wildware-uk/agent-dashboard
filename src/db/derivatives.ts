/**
 * `derivatives` (design §3, §6).
 *
 * One row per generated file: thumbnails at each width, a poster frame, a
 * transcoded mp4. `path` is relative to the media root — callers ask for a
 * variant, they never build a path (design §2).
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Derivative, DerivativeKind } from './types';

type Row = {
	seq: number;
	id: string;
	media_id: string;
	kind: DerivativeKind;
	path: string;
	bytes: number;
	width: number | null;
	height: number | null;
};

const COLUMNS = `seq, id, media_id, kind, path, bytes, width, height`;

function toDerivative(row: Row): Derivative {
	return {
		seq: row.seq,
		id: row.id,
		mediaId: row.media_id,
		kind: row.kind,
		path: row.path,
		bytes: row.bytes,
		width: row.width,
		height: row.height
	};
}

export type NewDerivative = {
	id?: string;
	mediaId: string;
	kind: DerivativeKind;
	/** Relative to the media root. */
	path: string;
	bytes: number;
	width?: number | null;
	height?: number | null;
};

/** Insert. Throws if this media already has this kind at this width. */
export function insertDerivative(db: Db, input: NewDerivative): Derivative {
	const row = {
		id: input.id ?? newId(),
		media_id: input.mediaId,
		kind: input.kind,
		path: input.path,
		bytes: input.bytes,
		width: orNull(input.width),
		height: orNull(input.height)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO derivatives (id, media_id, kind, path, bytes, width, height)
			 VALUES (:id, :media_id, :kind, :path, :bytes, :width, :height)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toDerivative(inserted);
}

/**
 * Insert, or replace the row for this media, kind and width.
 *
 * Reprocessing the same media is a normal event — a retried job, a changed
 * thumbnail size — and it should not need the caller to check first.
 */
export function upsertDerivative(db: Db, input: NewDerivative): Derivative {
	const row = {
		id: input.id ?? newId(),
		media_id: input.mediaId,
		kind: input.kind,
		path: input.path,
		bytes: input.bytes,
		width: orNull(input.width),
		height: orNull(input.height)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO derivatives (id, media_id, kind, path, bytes, width, height)
			 VALUES (:id, :media_id, :kind, :path, :bytes, :width, :height)
			 ON CONFLICT (media_id, kind, coalesce(width, -1)) DO UPDATE SET
				path = excluded.path,
				bytes = excluded.bytes,
				height = excluded.height
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toDerivative(inserted);
}

/** Every derivative of one media item, smallest first. */
export function listDerivatives(db: Db, mediaId: string): Derivative[] {
	return db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM derivatives WHERE media_id = ? ORDER BY kind, width, seq`
		)
		.all(mediaId)
		.map(toDerivative);
}

/** One variant, for serving. `width` is only meaningful for thumbnails. */
export function findDerivative(
	db: Db,
	mediaId: string,
	kind: DerivativeKind,
	width?: number | null
): Derivative | undefined {
	const params = { media_id: mediaId, kind, width: orNull(width) };
	const row = db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM derivatives
			 WHERE media_id = :media_id AND kind = :kind
			   AND (:width IS NULL OR width = :width)
			 ORDER BY width
			 LIMIT 1`
		)
		.get(params);

	return row && toDerivative(row);
}

/** Drop every derivative of one media item. @returns how many rows went. */
export function deleteDerivatives(db: Db, mediaId: string): number {
	return db.prepare(`DELETE FROM derivatives WHERE media_id = ?`).run(mediaId).changes;
}
