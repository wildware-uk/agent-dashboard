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
import { sql as messageDeliveries } from './018-message-deliveries';
import { sql as deliveryPerClient } from './019-delivery-per-client';
import { sql as answeringAComment } from './020-answering-a-comment';
import { sql as notifications } from './021-notifications';
import { sql as questionsInThreads } from './022-questions-in-threads';
import { sql as rescueOrphanedReplies } from './023-rescue-orphaned-replies';
import { sql as reactions } from './024-reactions';
import { sql as cursorPerProject } from './025-cursor-per-project';
import { sql as anyFile } from './026-any-file';
import { sql as embeds } from './027-embeds';
import { sql as embedsLookLikeTheirSources } from './028-embeds-look-like-their-sources';
import { sql as embedsCarryTheirMark } from './029-embeds-carry-their-mark';
import { sql as everyCardCarriesTheSameThings } from './030-every-card-carries-the-same-things';
import { sql as talkingAQuestionOverFirst } from './032-talking-a-question-over-first';
import { sql as workThatMovesComesBack } from './037-work-that-moves-comes-back';
import { sql as soundOnACard } from './038-sound-on-a-card';
import { sql as tagsOnACard } from './039-tags-on-a-card';
import { sql as notesOnACard } from './040-notes-on-a-card';
import { sql as anAppOnACard } from './041-an-app-on-a-card';
import { sql as anAppThatLivesSomewhereElse } from './042-an-app-that-lives-somewhere-else';
import { sql as ownerDevices } from './043-owner-devices';
import { sql as mentions } from './044-mentions';
import { sql as alertProjects } from './045-alert-projects';
import { sql as oldTasksAreNotNews } from './036-old-tasks-are-not-news';
import { sql as workLivesInTheFeed } from './035-work-lives-in-the-feed';
import { sql as oneKindOfCard } from './034-one-kind-of-card';
import { sql as secondThoughts } from './033-second-thoughts';
import { sql as agentWithdrawsItsOwnQuestion } from './031-an-agent-withdraws-its-own-question';

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
	{ version: 17, name: 'message-deletes', sql: messageDeletes },
	{ version: 18, name: 'message-deliveries', sql: messageDeliveries },
	{ version: 19, name: 'delivery-per-client', sql: deliveryPerClient },
	{ version: 20, name: 'answering-a-comment', sql: answeringAComment },
	{ version: 21, name: 'notifications', sql: notifications },
	{ version: 22, name: 'questions-in-threads', sql: questionsInThreads },
	{ version: 23, name: 'rescue-orphaned-replies', sql: rescueOrphanedReplies },
	{ version: 24, name: 'reactions', sql: reactions },
	{ version: 25, name: 'cursor-per-project', sql: cursorPerProject, rebuildsTables: true },
	{ version: 26, name: 'any-file', sql: anyFile, rebuildsTables: true },
	{ version: 27, name: 'embeds', sql: embeds },
	{
		version: 28,
		name: 'embeds-look-like-their-sources',
		sql: embedsLookLikeTheirSources
	},
	{ version: 29, name: 'embeds-carry-their-mark', sql: embedsCarryTheirMark },
	{
		version: 30,
		name: 'every-card-carries-the-same-things',
		sql: everyCardCarriesTheSameThings
	},
	{
		version: 31,
		name: 'an-agent-withdraws-its-own-question',
		sql: agentWithdrawsItsOwnQuestion,
		rebuildsTables: true
	},
	{ version: 32, name: 'talking-a-question-over-first', sql: talkingAQuestionOverFirst },
	{ version: 33, name: 'second-thoughts', sql: secondThoughts },
	{ version: 34, name: 'one-kind-of-card', sql: oneKindOfCard, rebuildsTables: true },
	{ version: 35, name: 'work-lives-in-the-feed', sql: workLivesInTheFeed },
	{ version: 36, name: 'old-tasks-are-not-news', sql: oldTasksAreNotNews },
	{ version: 37, name: 'work-that-moves-comes-back', sql: workThatMovesComesBack },
	{ version: 38, name: 'sound-on-a-card', sql: soundOnACard, rebuildsTables: true },
	{ version: 39, name: 'tags-on-a-card', sql: tagsOnACard },
	{ version: 40, name: 'notes-on-a-card', sql: notesOnACard },
	{ version: 41, name: 'an-app-on-a-card', sql: anAppOnACard },
	{
		version: 42,
		name: 'an-app-that-lives-somewhere-else',
		sql: anAppThatLivesSomewhereElse
	},
	{ version: 43, name: 'owner-devices', sql: ownerDevices },
	{ version: 44, name: 'mentions', sql: mentions },
	{ version: 45, name: 'alert-projects', sql: alertProjects }
];
