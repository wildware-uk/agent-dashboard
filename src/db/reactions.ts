/**
 * `reactions` (migration 024).
 *
 * One row per (message, actor, emoji), toggled: reacting is a switch rather
 * than an event, so the same call twice leaves the same state and a reactor
 * taking one back is a delete. `actor` is the literal `human` or
 * `agent:<agent_id>` — this layer stores the string and does not interpret it.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { Reaction } from './types';

type Row = {
	seq: number;
	id: string;
	message_id: string;
	actor: string;
	emoji: string;
	created_at: number;
};

const COLUMNS = `seq, id, message_id, actor, emoji, created_at`;

function toReaction(row: Row): Reaction {
	return {
		seq: row.seq,
		id: row.id,
		messageId: row.message_id,
		actor: row.actor,
		emoji: row.emoji,
		createdAt: row.created_at
	};
}

/**
 * Add one reaction, or report that it was already there.
 *
 * `ON CONFLICT DO NOTHING`, so a retry after a dropped connection is not a
 * second reaction and does not publish a second event.
 */
export function addReaction(
	db: Db,
	input: { messageId: string; actor: string; emoji: string; at?: number }
): { reaction: Reaction; created: boolean } {
	const row = {
		id: newId(),
		message_id: input.messageId,
		actor: input.actor,
		emoji: input.emoji,
		created_at: input.at ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO reactions (id, message_id, actor, emoji, created_at)
			 VALUES (:id, :message_id, :actor, :emoji, :created_at)
			 ON CONFLICT (message_id, actor, emoji) DO NOTHING
			 RETURNING ${COLUMNS}`
		)
		.get(row);
	if (inserted) return { reaction: toReaction(inserted), created: true };

	const existing = db
		.prepare<[string, string, string], Row>(
			`SELECT ${COLUMNS} FROM reactions
			  WHERE message_id = ? AND actor = ? AND emoji = ?`
		)
		.get(input.messageId, input.actor, input.emoji)!;
	return { reaction: toReaction(existing), created: false };
}

/** Take one back. @returns whether there was one to remove. */
export function removeReaction(
	db: Db,
	input: { messageId: string; actor: string; emoji: string }
): boolean {
	return (
		db
			.prepare<[string, string, string]>(
				`DELETE FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?`
			)
			.run(input.messageId, input.actor, input.emoji).changes > 0
	);
}

/** Every reaction on these messages, oldest first — the order a card shows them. */
export function listReactions(db: Db, messageIds: readonly string[]): Reaction[] {
	if (messageIds.length === 0) return [];

	const placeholders = messageIds.map(() => '?').join(', ');
	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM reactions
			  WHERE message_id IN (${placeholders})
			  ORDER BY seq`
		)
		.all(...messageIds)
		.map(toReaction);
}
