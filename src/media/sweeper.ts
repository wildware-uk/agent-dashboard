/**
 * Garbage collection for media nothing points at (design §3, §6).
 *
 * `media.update_id` is nullable because the upload happens *before* the update
 * that references it, which means every abandoned upload leaves a row and a file
 * behind: an agent that crashed between `create_upload` and `post_update`, one
 * that changed its mind, one whose token expired unspent. The design's rule is
 * that such a row is collected an hour after it was created.
 *
 * Two deliberate widenings of that rule:
 *
 * - **`pending` and `failed` are collected too**, not just `ready`. The design
 *   names `ready` because that is where an uploaded item rests once the
 *   derivative pipeline has run; but an upload token lives fifteen minutes, so a
 *   `pending` row an hour old can never be completed by anybody, and a `failed`
 *   one is not going to be either. Leaving them would mean the only rows that
 *   never get collected are the ones that never worked.
 * - **The batch is bounded.** This runs in the same process that serves the
 *   dashboard, and a first run over a neglected data directory should not hold
 *   the event loop while it unlinks ten thousand directories.
 *
 * Deleting the row is what deletes the token rows with it (`ON DELETE CASCADE`),
 * and deleting the directory is safe for deduplicated uploads: identical bytes
 * are hard links, so removing one name leaves every other row's file intact.
 */
import {
	deleteExpiredUploadTokens,
	deleteMedia,
	listOrphanedMedia,
	type Db,
	type MediaStatus
} from '$db';
import { rm } from 'node:fs/promises';
import { mediaDir } from './paths';
import type { MediaSettings } from './settings';

/** How long an unattached media row is given before it is collected (design §3). */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** Rows the sweeper considers. See the note above on why it is all three. */
export const SWEPT_STATUSES: readonly MediaStatus[] = ['ready', 'pending', 'failed'];

/** Most rows one run will collect. */
export const SWEEP_BATCH = 200;

export type SweepInput = {
	db: Db;
	now?: number;
	/** How old an orphan must be. Defaults to {@link ORPHAN_AGE_MS}. */
	olderThanMs?: number;
	/** Most rows to collect in this run. Defaults to {@link SWEEP_BATCH}. */
	limit?: number;
};

export type SweepResult = {
	/** Media rows deleted, with their files. */
	media: number;
	/** Bytes those rows claimed, as a number for a log line. */
	bytes: number;
	/** Unused, expired upload tokens deleted. */
	tokens: number;
};

/**
 * Collect orphaned media and expired tokens.
 *
 * Files first, then the row: a file with no row is invisible and merely wastes
 * disk, whereas a row with no file is a broken image in the owner's timeline.
 */
export async function sweepOrphanedMedia(
	settings: MediaSettings,
	input: SweepInput
): Promise<SweepResult> {
	const now = input.now ?? Date.now();
	const createdBefore = now - (input.olderThanMs ?? ORPHAN_AGE_MS);

	const orphans = listOrphanedMedia(input.db, {
		createdBefore,
		statuses: SWEPT_STATUSES,
		limit: input.limit ?? SWEEP_BATCH
	});

	let media = 0;
	let bytes = 0;

	for (const orphan of orphans) {
		await rm(mediaDir(settings, orphan.id), { recursive: true, force: true });
		if (deleteMedia(input.db, orphan.id)) {
			media += 1;
			bytes += orphan.bytes;
		}
	}

	// Tokens whose media survived — because it was attached in the meantime — but
	// which were never spent. Spent tokens stay: they are the record of an upload.
	const tokens = deleteExpiredUploadTokens(input.db, now);

	return { media, bytes, tokens };
}
