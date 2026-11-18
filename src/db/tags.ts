/**
 * `tags` and `card_tags` (migration 039).
 *
 * A project's own vocabulary, and one of its words on one card.
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 *
 * Two facts, kept apart on purpose: defining "bug" for a project is a decision
 * somebody makes once, and putting "bug" on a card is a click. The card is named
 * the generic way (`./cards.ts`), so tagging a question took no new SQL.
 */
import { CARD_ANCHOR, type CardRef } from './cards';
import type { Db } from './connection';
import { newId } from './ids';
import type { CardTag, Tag } from './types';

type TagRow = {
	seq: number;
	id: string;
	project_id: string;
	name: string;
	slug: string;
	colour: string | null;
	agent_id: string | null;
	created_at: number;
};

const TAG_COLUMNS = `seq, id, project_id, name, slug, colour, agent_id, created_at`;

function toTag(row: TagRow): Tag {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		name: row.name,
		slug: row.slug,
		colour: row.colour,
		agentId: row.agent_id,
		createdAt: row.created_at
	};
}

export type NewTag = {
	projectId: string;
	name: string;
	slug: string;
	colour?: string | null;
	agentId?: string | null;
	createdAt?: number;
};

/**
 * Define a tag, or hand back the one that is already there.
 *
 * `ON CONFLICT DO NOTHING` on `(project_id, slug)`, so two agents defining "bug"
 * at the same moment end with one tag rather than a refusal somebody has to
 * handle. The colour of the first definition wins: a second caller's opinion
 * about the shade is not worth overwriting a word the project is already using.
 */
export function insertTag(db: Db, input: NewTag): Tag {
	const row = {
		id: newId(),
		project_id: input.projectId,
		name: input.name,
		slug: input.slug,
		colour: input.colour ?? null,
		agent_id: input.agentId ?? null,
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, TagRow>(
			`INSERT INTO tags (id, project_id, name, slug, colour, agent_id, created_at)
			 VALUES (@id, @project_id, @name, @slug, @colour, @agent_id, @created_at)
			 ON CONFLICT (project_id, slug) DO NOTHING
			 RETURNING ${TAG_COLUMNS}`
		)
		.get(row);

	return inserted ? toTag(inserted) : findTagBySlug(db, input.projectId, input.slug)!;
}

export function findTagById(db: Db, id: string): Tag | undefined {
	const row = db.prepare<[string], TagRow>(`SELECT ${TAG_COLUMNS} FROM tags WHERE id = ?`).get(id);
	return row && toTag(row);
}

export function findTagBySlug(db: Db, projectId: string, slug: string): Tag | undefined {
	const row = db
		.prepare<[string, string], TagRow>(
			`SELECT ${TAG_COLUMNS} FROM tags WHERE project_id = ? AND slug = ?`
		)
		.get(projectId, slug);
	return row && toTag(row);
}

/** A project's vocabulary, oldest first: the order it was decided in. */
export function listTags(db: Db, projectIds?: readonly string[]): Tag[] {
	if (projectIds?.length === 0) return [];
	const scope = projectIds ? `WHERE project_id IN (${projectIds.map(() => '?').join(', ')})` : '';

	return db
		.prepare<unknown[], TagRow>(`SELECT ${TAG_COLUMNS} FROM tags ${scope} ORDER BY seq`)
		.all(...(projectIds ?? []))
		.map(toTag);
}

/** Rename a tag, or recolour it. The word moves on every card carrying it. */
export function updateTag(
	db: Db,
	id: string,
	patch: { name?: string; slug?: string; colour?: string | null }
): Tag | undefined {
	const current = findTagById(db, id);
	if (!current) return undefined;

	const row = db
		.prepare<[string, string, string | null, string], TagRow>(
			`UPDATE tags SET name = ?, slug = ?, colour = ? WHERE id = ? RETURNING ${TAG_COLUMNS}`
		)
		.get(
			patch.name ?? current.name,
			patch.slug ?? current.slug,
			patch.colour === undefined ? current.colour : patch.colour,
			id
		);

	return row && toTag(row);
}

/**
 * Retire a tag, taking it off every card at once.
 *
 * A hard delete rather than a flag: a tag nobody uses any more should stop being
 * offered in the picker, and a card wearing a word the project has abandoned is
 * a word nobody can explain. The cards themselves are untouched.
 */
export function deleteTag(db: Db, id: string): boolean {
	return db.transaction(() => {
		db.prepare<[string]>(`DELETE FROM card_tags WHERE tag_id = ?`).run(id);
		return db.prepare<[string]>(`DELETE FROM tags WHERE id = ?`).run(id).changes > 0;
	})();
}

type CardTagRow = {
	seq: number;
	id: string;
	tag_id: string;
	update_id: string | null;
	message_id: string | null;
	request_id: string | null;
	author: string;
	created_at: number;
};

const CARD_TAG_COLUMNS = `seq, id, tag_id, update_id, message_id, request_id, author, created_at`;

function toCardTag(row: CardTagRow): CardTag {
	const card: CardRef = row.update_id
		? { kind: 'update', id: row.update_id }
		: row.message_id
			? { kind: 'message', id: row.message_id }
			: { kind: 'request', id: row.request_id! };

	return {
		seq: row.seq,
		id: row.id,
		tagId: row.tag_id,
		card,
		author: row.author,
		createdAt: row.created_at
	};
}

/**
 * Put a tag on a card, or report that it was already there.
 *
 * `ON CONFLICT DO NOTHING` against the anchor's own partial index, exactly as a
 * reaction does: the same click twice is the same tag, and a retry after a
 * dropped connection must not publish a second event.
 *
 * @returns the row, or `undefined` when the tag was already on the card.
 */
export function addCardTag(
	db: Db,
	input: { card: CardRef; tagId: string; author: string; createdAt?: number }
): CardTag | undefined {
	const anchor = CARD_ANCHOR[input.card.kind];
	const row = db
		.prepare<[string, string, string, string, number], CardTagRow>(
			`INSERT INTO card_tags (id, tag_id, ${anchor}, author, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (tag_id, ${anchor}) WHERE ${anchor} IS NOT NULL DO NOTHING
			 RETURNING ${CARD_TAG_COLUMNS}`
		)
		.get(newId(), input.tagId, input.card.id, input.author, input.createdAt ?? Date.now());

	return row && toCardTag(row);
}

/** Take a tag off a card. `false` when it was not on it. */
export function removeCardTag(db: Db, card: CardRef, tagId: string): boolean {
	const anchor = CARD_ANCHOR[card.kind];
	return (
		db
			.prepare<[string, string]>(`DELETE FROM card_tags WHERE tag_id = ? AND ${anchor} = ?`)
			.run(tagId, card.id).changes > 0
	);
}

/** Is this tag on this card? */
export function findCardTag(db: Db, card: CardRef, tagId: string): CardTag | undefined {
	const anchor = CARD_ANCHOR[card.kind];
	const row = db
		.prepare<[string, string], CardTagRow>(
			`SELECT ${CARD_TAG_COLUMNS} FROM card_tags WHERE tag_id = ? AND ${anchor} = ?`
		)
		.get(tagId, card.id);
	return row && toCardTag(row);
}

/**
 * Every tag on these cards, in one query per kind.
 *
 * The feed asks for a page of cards at a time, so this takes ids rather than one
 * card: a query per card is the fan-out that makes a long feed slow.
 */
export function listCardTags(
	db: Db,
	scope: Partial<Record<CardRef['kind'], readonly string[]>>
): CardTag[] {
	const found: CardTag[] = [];

	for (const [kind, ids] of Object.entries(scope) as [CardRef['kind'], readonly string[]][]) {
		if (!ids || ids.length === 0) continue;
		const anchor = CARD_ANCHOR[kind];
		const rows = db
			.prepare<unknown[], CardTagRow>(
				`SELECT ${CARD_TAG_COLUMNS} FROM card_tags
				  WHERE ${anchor} IN (${ids.map(() => '?').join(', ')})
				  ORDER BY seq`
			)
			.all(...ids);
		found.push(...rows.map(toCardTag));
	}

	return found;
}
