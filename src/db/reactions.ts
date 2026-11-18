/**
 * `reactions` (migration 024, generalised by 034).
 *
 * One row per (card, actor, emoji), toggled: reacting is a switch rather than an
 * event, so the same call twice leaves the same state and a reactor taking one
 * back is a delete. `actor` is the literal `human` or `agent:<agent_id>` — this
 * layer stores the string and does not interpret it.
 *
 * The card is named by {@link CardRef} and written to one of four nullable
 * columns (`$db/cards.ts`). Every statement here is built from that one anchor
 * rather than repeated per kind, which is the whole of what "generic" buys: an
 * emoji on a task took no new SQL.
 */
import { CARD_ANCHOR, type CardKind, type CardRef } from './cards';
import type { Db } from './connection';
import { newId } from './ids';
import type { Reaction } from './types';

type Row = {
	seq: number;
	id: string;
	message_id: string | null;
	update_id: string | null;
	request_id: string | null;
	task_id: string | null;
	actor: string;
	emoji: string;
	created_at: number;
};

const COLUMNS = `seq, id, message_id, update_id, request_id, task_id, actor, emoji, created_at`;

function toReaction(row: Row): Reaction {
	const card: CardRef = row.message_id
		? { kind: 'message', id: row.message_id }
		: row.update_id
			? { kind: 'update', id: row.update_id }
			: { kind: 'request', id: row.request_id! };

	return {
		seq: row.seq,
		id: row.id,
		card,
		// The message it is on, for the many readers that predate migration 034
		// and only ever ask about a thread.
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
 * second reaction and does not publish a second event. The conflict target is
 * the anchor's own partial index: `NULL` is not equal to itself in SQLite, so
 * one index across the four columns would enforce nothing (migration 034).
 */
export function addReaction(
	db: Db,
	input: { card: CardRef; actor: string; emoji: string; at?: number }
): { reaction: Reaction; created: boolean } {
	const anchor = CARD_ANCHOR[input.card.kind];
	const row = {
		id: newId(),
		card_id: input.card.id,
		actor: input.actor,
		emoji: input.emoji,
		created_at: input.at ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO reactions (id, ${anchor}, actor, emoji, created_at)
			 VALUES (:id, :card_id, :actor, :emoji, :created_at)
			 ON CONFLICT (${anchor}, actor, emoji) WHERE ${anchor} IS NOT NULL DO NOTHING
			 RETURNING ${COLUMNS}`
		)
		.get(row);
	if (inserted) return { reaction: toReaction(inserted), created: true };

	const existing = db
		.prepare<[string, string, string], Row>(
			`SELECT ${COLUMNS} FROM reactions
			  WHERE ${anchor} = ? AND actor = ? AND emoji = ?`
		)
		.get(input.card.id, input.actor, input.emoji)!;
	return { reaction: toReaction(existing), created: false };
}

/** Take one back. @returns whether there was one to remove. */
export function removeReaction(
	db: Db,
	input: { card: CardRef; actor: string; emoji: string }
): boolean {
	const anchor = CARD_ANCHOR[input.card.kind];
	return (
		db
			.prepare<[string, string, string]>(
				`DELETE FROM reactions WHERE ${anchor} = ? AND actor = ? AND emoji = ?`
			)
			.run(input.card.id, input.actor, input.emoji).changes > 0
	);
}

/**
 * Every reaction on these cards, oldest first — the order a card shows them.
 *
 * Takes one kind and many ids because that is what a page asks for: the
 * reactions on the messages in a thread, or on the updates in a timeline.
 */
export function listReactions(db: Db, kind: CardKind, ids: readonly string[]): Reaction[] {
	if (ids.length === 0) return [];

	const anchor = CARD_ANCHOR[kind];
	const placeholders = ids.map(() => '?').join(', ');
	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM reactions
			  WHERE ${anchor} IN (${placeholders})
			  ORDER BY seq`
		)
		.all(...ids)
		.map(toReaction);
}
