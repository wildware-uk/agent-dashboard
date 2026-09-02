/**
 * The ordered migration list.
 *
 * Migrations are numbered, append-only, and never edited once applied — the
 * runner refuses to start if an applied migration's SQL has changed, because
 * the database in front of it no longer matches the code's idea of it.
 */
import { sql as initialSchema } from './001-initial-schema';
import { sql as ownerRequests } from './002-owner-requests';
import { sql as pushSubscriptions } from './003-push-subscriptions';
import { sql as updateEdits } from './004-update-edits';
import { sql as updateShares } from './005-update-shares';
import { sql as projectTheme } from './006-project-theme';
import { sql as priorityAndPushPrefs } from './007-priority-and-push-prefs';
import { sql as updatesOnTasks } from './008-updates-on-tasks';
import { sql as projectBoard } from './009-project-board';
import { sql as taskBroadcast } from './010-task-broadcast';
import { sql as projectSeen } from './011-project-seen';
import { sql as seenWhatIsAlreadyRead } from './012-seen-what-is-already-read';
import { sql as acknowledgements } from './013-acknowledgements';
import { sql as messageReplies } from './014-message-replies';
import { sql as repliesSeen } from './015-replies-seen';
import { sql as ownerMedia } from './016-owner-media';
import { sql as messageDeletes } from './017-message-deletes';

export type Migration = {
	/** 1-based, contiguous, and permanent once shipped. */
	version: number;
	/** Human label, recorded alongside the version so a log line reads. */
	name: string;
	/** One or more statements, applied as a single transaction. */
	sql: string;
	/**
	 * Turn foreign keys off around this migration, for a table rebuild.
	 *
	 * SQLite cannot drop a `NOT NULL` or a column reference in place, so changing
	 * one means the documented twelve-step dance: build the new table, copy, drop
	 * the old, rename. With foreign keys **on**, the drop cascades — every
	 * `upload_tokens` row referencing `media` would go with it — and
	 * `PRAGMA foreign_keys` is a no-op inside a transaction, so the migration
	 * cannot turn them off itself.
	 *
	 * The runner does it instead, exactly as the SQLite docs prescribe: pragma
	 * off, BEGIN, rebuild, COMMIT, pragma on, then `foreign_key_check` to prove
	 * nothing was left dangling. Atomicity is unchanged; only the enforcement
	 * window moves.
	 *
	 * Set this only for a rebuild, and only when there is no other shape.
	 */
	rebuildsTables?: true;
};

export const MIGRATIONS: readonly Migration[] = [
	{ version: 1, name: 'initial-schema', sql: initialSchema },
	{ version: 2, name: 'owner-requests', sql: ownerRequests },
	{ version: 3, name: 'push-subscriptions', sql: pushSubscriptions },
	{ version: 4, name: 'update-edits', sql: updateEdits },
	{ version: 5, name: 'update-shares', sql: updateShares },
	{ version: 6, name: 'project-theme', sql: projectTheme },
	{ version: 7, name: 'priority-and-push-prefs', sql: priorityAndPushPrefs },
	{ version: 8, name: 'updates-on-tasks', sql: updatesOnTasks },
	{ version: 9, name: 'project-board', sql: projectBoard },
	{ version: 10, name: 'task-broadcast', sql: taskBroadcast },
	{ version: 11, name: 'project-seen', sql: projectSeen },
	{ version: 12, name: 'seen-what-is-already-read', sql: seenWhatIsAlreadyRead },
	{ version: 13, name: 'acknowledgements', sql: acknowledgements },
	{ version: 14, name: 'message-replies', sql: messageReplies },
	{ version: 15, name: 'replies-seen', sql: repliesSeen },
	{ version: 16, name: 'owner-media', sql: ownerMedia, rebuildsTables: true },
	{ version: 17, name: 'message-deletes', sql: messageDeletes }
];
