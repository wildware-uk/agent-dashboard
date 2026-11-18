/**
 * `card_fields` (migration 040) — what somebody knows about a card.
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like."
 *
 * One row per (card, name). The card is named the generic way (`./cards.ts`), so
 * a field on a question took no new SQL, and `slug` is what decides whether two
 * writes are the same field — see migration 040 for why the name is kept twice.
 */
import { CARD_ANCHOR, type CardKind, type CardRef } from './cards';
import type { Db } from './connection';
import { newId } from './ids';
import type { CardField } from './types';

type Row = {
	seq: number;
	id: string;
	update_id: string | null;
	message_id: string | null;
	request_id: string | null;
	name: string;
	slug: string;
	value: string;
	author: string;
	created_at: number;
	updated_at: number;
};

const COLUMNS = `seq, id, update_id, message_id, request_id, name, slug, value, author,
	created_at, updated_at`;

function toField(row: Row): CardField {
	const card: CardRef = row.update_id
		? { kind: 'update', id: row.update_id }
		: row.message_id
			? { kind: 'message', id: row.message_id }
			: { kind: 'request', id: row.request_id! };

	return {
		seq: row.seq,
		id: row.id,
		card,
		name: row.name,
		slug: row.slug,
		value: row.value,
		author: row.author,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export type NewCardField = {
	card: CardRef;
	name: string;
	slug: string;
	value: string;
	author: string;
	now?: number;
};

/**
 * Set a field, or correct the one already there.
 *
 * `ON CONFLICT DO UPDATE` against the anchor's own partial index: an agent that
 * learns the branch name twice has corrected itself, not written two fields.
 * `created_at` is left alone on a correction — when the note first appeared is a
 * different fact from when it was last touched, and the card shows both.
 */
export function upsertCardField(db: Db, input: NewCardField): CardField {
	const anchor = CARD_ANCHOR[input.card.kind];
	const at = input.now ?? Date.now();

	const row = db
		.prepare<[string, string, string, string, string, string, number, number], Row>(
			`INSERT INTO card_fields (id, ${anchor}, name, slug, value, author, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (${anchor}, slug) WHERE ${anchor} IS NOT NULL
			 DO UPDATE SET name = excluded.name, value = excluded.value,
			               author = excluded.author, updated_at = excluded.updated_at
			 RETURNING ${COLUMNS}`
		)
		.get(newId(), input.card.id, input.name, input.slug, input.value, input.author, at, at)!;

	return toField(row);
}

/** Take a field off a card. `false` when it was not there. */
export function deleteCardField(db: Db, card: CardRef, slug: string): boolean {
	const anchor = CARD_ANCHOR[card.kind];
	return (
		db
			.prepare<[string, string]>(`DELETE FROM card_fields WHERE ${anchor} = ? AND slug = ?`)
			.run(card.id, slug).changes > 0
	);
}

/** One field, by the name it is judged on. */
export function findCardField(db: Db, card: CardRef, slug: string): CardField | undefined {
	const anchor = CARD_ANCHOR[card.kind];
	const row = db
		.prepare<[string, string], Row>(
			`SELECT ${COLUMNS} FROM card_fields WHERE ${anchor} = ? AND slug = ?`
		)
		.get(card.id, slug);
	return row && toField(row);
}

/**
 * Every field on these cards, in one query per kind.
 *
 * Ids rather than one card, for the reason every other card read takes a page:
 * a query per card is the fan-out that makes a long feed slow.
 */
export function listCardFields(
	db: Db,
	scope: Partial<Record<CardKind, readonly string[]>>
): CardField[] {
	const found: CardField[] = [];

	for (const [kind, ids] of Object.entries(scope) as [CardKind, readonly string[]][]) {
		if (!ids || ids.length === 0) continue;
		const anchor = CARD_ANCHOR[kind];
		const rows = db
			.prepare<unknown[], Row>(
				`SELECT ${COLUMNS} FROM card_fields
				  WHERE ${anchor} IN (${ids.map(() => '?').join(', ')})
				  ORDER BY seq`
			)
			.all(...ids);
		found.push(...rows.map(toField));
	}

	return found;
}
