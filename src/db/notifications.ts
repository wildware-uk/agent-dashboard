/**
 * `notifications` (migration 021): what the owner has been told about.
 *
 * A row per thing worth their attention — an agent's update, an agent's reply,
 * a request waiting on them — written by the same events that send a push, so
 * the app can show the list whether or not any push was ever delivered.
 *
 * Insertion is `ON CONFLICT DO NOTHING` against the per-target unique indexes:
 * the bus can replay, two subscribers can race, and a notification that
 * appeared twice would double a count the owner reads as "how much is waiting".
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Notification, NotificationKind } from './types';

type Row = {
	seq: number;
	id: string;
	kind: NotificationKind;
	project_id: string | null;
	update_id: string | null;
	message_id: string | null;
	request_id: string | null;
	agent_id: string | null;
	title: string;
	body: string;
	created_at: number;
	seen_at: number | null;
};

const COLUMNS = `seq, id, kind, project_id, update_id, message_id, request_id, agent_id, title, body, created_at, seen_at`;

function toNotification(row: Row): Notification {
	return {
		seq: row.seq,
		id: row.id,
		kind: row.kind,
		projectId: row.project_id,
		updateId: row.update_id,
		messageId: row.message_id,
		requestId: row.request_id,
		agentId: row.agent_id,
		title: row.title,
		body: row.body,
		createdAt: row.created_at,
		seenAt: row.seen_at
	};
}

export type NewNotification = {
	kind: NotificationKind;
	projectId?: string | null;
	updateId?: string | null;
	messageId?: string | null;
	requestId?: string | null;
	agentId?: string | null;
	title: string;
	body: string;
	createdAt?: number;
};

/**
 * Record one notification.
 *
 * @returns the row and whether this call created it, so only the first
 *   publishes an event.
 */
export function insertNotification(
	db: Db,
	input: NewNotification
): { notification: Notification; created: boolean } {
	const row = {
		id: newId(),
		kind: input.kind,
		project_id: orNull(input.projectId),
		update_id: orNull(input.updateId),
		message_id: orNull(input.messageId),
		request_id: orNull(input.requestId),
		agent_id: orNull(input.agentId),
		title: input.title,
		body: input.body,
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO notifications
			   (id, kind, project_id, update_id, message_id, request_id, agent_id, title, body, created_at)
			 VALUES
			   (:id, :kind, :project_id, :update_id, :message_id, :request_id, :agent_id, :title, :body, :created_at)
			 ON CONFLICT DO NOTHING
			 RETURNING ${COLUMNS}`
		)
		.get(row);

	if (inserted) return { notification: toNotification(inserted), created: true };

	// Already recorded: hand back what is there rather than making the caller ask.
	const target = {
		update_id: row.update_id,
		message_id: row.message_id,
		request_id: row.request_id
	};
	const existing = db
		.prepare<typeof target, Row>(
			`SELECT ${COLUMNS} FROM notifications
			  WHERE (:update_id IS NOT NULL AND update_id = :update_id)
			     OR (:message_id IS NOT NULL AND message_id = :message_id)
			     OR (:request_id IS NOT NULL AND request_id = :request_id)`
		)
		.get(target);

	return { notification: toNotification(existing!), created: false };
}

export type NotificationQuery = {
	/** Only what has not been marked seen. */
	unseenOnly?: boolean;
	/** Default 50. */
	limit?: number;
};

/** Newest first: a notification list is read from the top. */
export function listNotifications(db: Db, query: NotificationQuery = {}): Notification[] {
	const params = [query.unseenOnly ? 1 : 0, query.limit ?? 50];
	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM notifications
			  WHERE (? = 0 OR seen_at IS NULL)
			  ORDER BY seq DESC
			  LIMIT ?`
		)
		.all(...params)
		.map(toNotification);
}

/** How many the owner has not looked at. */
export function countUnseenNotifications(db: Db): number {
	return db
		.prepare<[], { n: number }>(`SELECT count(*) AS n FROM notifications WHERE seen_at IS NULL`)
		.get()!.n;
}

/**
 * Mark notifications seen.
 *
 * With ids, only those; without, everything unseen — which is what "mark all
 * read" means and is one statement rather than a list the client has to build.
 *
 * @returns how many rows this call changed.
 */
export function markNotificationsSeen(
	db: Db,
	options: { ids?: readonly string[]; at?: number } = {}
): number {
	const at = options.at ?? Date.now();

	if (!options.ids) {
		return db
			.prepare<[number]>(`UPDATE notifications SET seen_at = ? WHERE seen_at IS NULL`)
			.run(at).changes;
	}
	if (options.ids.length === 0) return 0;

	const placeholders = options.ids.map(() => '?').join(', ');
	return db
		.prepare<unknown[]>(
			`UPDATE notifications SET seen_at = ?
			  WHERE seen_at IS NULL AND id IN (${placeholders})`
		)
		.run(at, ...options.ids).changes;
}
