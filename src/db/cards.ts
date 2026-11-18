/**
 * What every card has in common (migration 034).
 *
 * The owner: "there are many discrepancies between the card types, they should
 * all share the same features, and be implemented in a generic modular fashion."
 *
 * Four things appear in the feed — an update, one of the owner's own posts, a
 * question, a task — and each of them can carry media, embeds, a thread, a pin,
 * reactions and acknowledgements. Every one of those features names its card the
 * same way: a nullable column per kind, because SQLite can put a foreign key on
 * a column and cannot put one on a polymorphic `(kind, id)` pair. A reaction
 * pointing at a card that never existed is not a shape worth the generality.
 *
 * So the generality lives here instead, in one small vocabulary the feature
 * modules share: which column names a kind, which table holds it, and how to
 * turn a `{ kind, id }` into either. Adding a fifth card type means adding a
 * line to each map and a column to each feature table — not another copy of
 * `addReaction`.
 */
import type { Db } from './connection';

/**
 * The three things that appear in the feed.
 *
 * A task was the fourth until migration 035 took the board away: work is a state
 * a card is in now, so there is no second kind of thing to point at. The
 * `task_id` columns are still on the feature tables and are simply never set —
 * dropping a column is a table rebuild for nothing.
 */
export const CARD_KINDS = ['update', 'message', 'request'] as const;

/**
 * The states a card can be worked through (migration 035).
 *
 * The owner: "agents can mark a card in the feed as a task, and update the
 * status of the card, in progress, done, blocked etc." A card with no status is
 * an ordinary card; giving it one is what marking it as work means.
 */
export const CARD_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

/** Whether a string is one of the states, for a value off the wire. */
export function isCardStatus(value: unknown): value is CardStatus {
	return typeof value === 'string' && (CARD_STATUSES as readonly string[]).includes(value);
}

/** The states that mean the work is not over, which is what a count asks for. */
export const OPEN_STATUSES: readonly CardStatus[] = ['todo', 'in_progress', 'blocked'];

export type CardKind = (typeof CARD_KINDS)[number];

/** One card, named the way every feature module names it. */
export type CardRef = { kind: CardKind; id: string };

/**
 * The column a feature table uses to point at each kind.
 *
 * `request` is `request_id` while its table is `approvals`: the table kept
 * migration 001's name and the product calls them questions, which is a wart
 * worth one line here rather than a rename across every query that reads them.
 */
export const CARD_ANCHOR: Record<CardKind, string> = {
	update: 'update_id',
	message: 'message_id',
	request: 'request_id'
};

/** The table each kind lives in. */
export const CARD_TABLE: Record<CardKind, string> = {
	update: 'updates',
	message: 'messages',
	request: 'approvals'
};

/** Every anchor column, for the "attached to nothing at all" case. */
export const CARD_ANCHORS: readonly string[] = CARD_KINDS.map((kind) => CARD_ANCHOR[kind]);

/** Whether a string is one of the kinds, for a value off the wire. */
export function isCardKind(value: unknown): value is CardKind {
	return typeof value === 'string' && (CARD_KINDS as readonly string[]).includes(value);
}

/**
 * The little every card has: whether it exists, whose project it is in, and
 * whether it has been taken back.
 *
 * One query per kind rather than a union of four, because the caller always
 * knows which kind it is asking about. `deletedAt` is `null` for the kinds that
 * cannot be deleted — a task is cancelled rather than removed — which lets a
 * caller write one guard for all four.
 */
export type CardRow = {
	id: string;
	projectId: string | null;
	pinned: boolean;
	/** The work state, or `null` for a card nobody has marked as work. */
	status: CardStatus | null;
	/**
	 * When the state last changed (migration 037).
	 *
	 * What puts a card that moved back at the top of the feed. `null` for one
	 * whose state nobody has touched since the column existed.
	 */
	statusAt: number | null;
	deletedAt: number | null;
};

type Raw = {
	id: string;
	project_id: string | null;
	pinned: number;
	status: CardStatus | null;
	status_at: number | null;
	deleted_at: number | null;
};

/** What each table calls the two columns that are not called the same thing. */
/**
 * Which kinds can be marked as work.
 *
 * A question cannot: it ends by being answered and carries its own outcome,
 * which is a truer record than a state somebody set. Reading a constant for it
 * keeps one query shape for all three.
 */
const STATUS: Record<CardKind, string> = {
	update: 'status',
	message: 'status',
	request: 'NULL'
};

/** The same, for the moment the state last changed (migration 037). */
const STATUS_AT: Record<CardKind, string> = {
	update: 'status_at',
	message: 'status_at',
	request: 'NULL'
};

const DELETED: Record<CardKind, string> = {
	update: 'deleted_at',
	message: 'deleted_at',
	// A question ends by being answered, dismissed or withdrawn rather than
	// deleted, so the query reads a constant and every caller keeps one guard.
	request: 'NULL'
};

export function findCard(db: Db, card: CardRef): CardRow | undefined {
	const row = db
		.prepare<[string], Raw>(
			`SELECT id, project_id, pinned, ${STATUS[card.kind]} AS status,
			        ${STATUS_AT[card.kind]} AS status_at, ${DELETED[card.kind]} AS deleted_at
			   FROM ${CARD_TABLE[card.kind]} WHERE id = ?`
		)
		.get(card.id);

	return (
		row && {
			id: row.id,
			projectId: row.project_id,
			pinned: row.pinned === 1,
			status: row.status,
			statusAt: row.status_at,
			deletedAt: row.deleted_at
		}
	);
}

/**
 * Pin a card, or unpin it.
 *
 * @returns the card as it now stands, or `undefined` if there is no such row.
 */
export function setCardPinned(db: Db, card: CardRef, pinned: boolean): CardRow | undefined {
	const changed = db
		.prepare<[0 | 1, string]>(`UPDATE ${CARD_TABLE[card.kind]} SET pinned = ? WHERE id = ?`)
		.run(pinned ? 1 : 0, card.id).changes;

	return changed > 0 ? findCard(db, card) : undefined;
}

/**
 * Mark a card as work, move it along, or stop calling it work (migration 035).
 *
 * `null` clears it, which is how a card that was marked by mistake goes back to
 * being an ordinary card. Whether this kind of card can carry a state at all is
 * `$domain`'s to refuse.
 *
 * @returns the card as it now stands, or `undefined` if there is no such row.
 */
export function setCardStatus(
	db: Db,
	card: CardRef,
	status: CardStatus | null,
	at: number = Date.now()
): CardRow | undefined {
	// `status_at` moves with the state, because the feed files a card by when
	// something last happened to it (migration 037).
	const changed = db
		.prepare<[string | null, number, string]>(
			`UPDATE ${CARD_TABLE[card.kind]} SET status = ?, status_at = ? WHERE id = ?`
		)
		.run(status, at, card.id).changes;

	return changed > 0 ? findCard(db, card) : undefined;
}

/**
 * How many cards are open work, in these projects.
 *
 * One query per kind that can carry a state, counted in the statement rather
 * than in memory: this runs on every heartbeat and on every event that could
 * move it (design §5).
 */
export function countOpenWork(db: Db, projectIds?: readonly string[]): number {
	if (projectIds?.length === 0) return 0;

	const states = OPEN_STATUSES.map(() => '?').join(', ');
	const scope = projectIds ? `AND project_id IN (${projectIds.map(() => '?').join(', ')})` : '';
	const params = [...OPEN_STATUSES, ...(projectIds ?? [])];

	const row = db
		.prepare<unknown[], { total: number }>(
			`SELECT
			   (SELECT COUNT(*) FROM updates
			     WHERE status IN (${states}) AND deleted_at IS NULL ${scope})
			 + (SELECT COUNT(*) FROM messages
			     WHERE status IN (${states}) AND deleted_at IS NULL ${scope}) AS total`
		)
		.get(...params, ...params)!;

	return row.total;
}

/**
 * How many cards sit in each state, for the given projects.
 *
 * A count rather than {@link listWork}, which is capped and would undercount a
 * busy deployment.
 */
export function countWorkByStatus(
	db: Db,
	projectIds: readonly string[]
): Record<CardStatus, number> {
	const counts = Object.fromEntries(CARD_STATUSES.map((status) => [status, 0])) as Record<
		CardStatus,
		number
	>;
	if (projectIds.length === 0) return counts;

	const scope = projectIds.map(() => '?').join(', ');
	const rows = db
		.prepare<unknown[], { status: CardStatus; total: number }>(
			`SELECT status, COUNT(*) AS total FROM (
			   SELECT status FROM updates
			    WHERE status IS NOT NULL AND deleted_at IS NULL AND project_id IN (${scope})
			   UNION ALL
			   SELECT status FROM messages
			    WHERE status IS NOT NULL AND deleted_at IS NULL AND project_id IN (${scope})
			 ) GROUP BY status`
		)
		.all(...projectIds, ...projectIds);

	for (const row of rows) if (row.status in counts) counts[row.status] = row.total;
	return counts;
}

/**
 * One row of the work list: a card with a state on it (migration 035).
 *
 * Carries enough for an agent to decide what to pick up without a second call
 * per card — who wrote it, what it says, and when it last moved — and no more.
 * The whole body is deliberately not here: a work list of forty cards is not a
 * place to ship forty reports.
 */
export type WorkRow = {
	kind: CardKind;
	id: string;
	projectId: string | null;
	status: CardStatus;
	statusAt: number | null;
	createdAt: number;
	title: string | null;
	body: string;
	/** `human` for the owner, or `agent:<id>` — the vocabulary messages use. */
	author: string;
};

type RawWork = {
	kind: CardKind;
	id: string;
	project_id: string | null;
	status: CardStatus;
	status_at: number | null;
	created_at: number;
	title: string | null;
	body: string;
	author: string;
};

/** What {@link listWork} is asked for. */
export type WorkQuery = {
	/** Only these projects. Omitted means every project the caller may see. */
	projectIds?: readonly string[];
	/** Only these states. Omitted means every card that carries one. */
	statuses?: readonly CardStatus[];
	/** At most this many, newest movement first. */
	limit?: number;
};

/**
 * The cards that are work, newest movement first.
 *
 * The owner: "allow agents to filter cards by work status, ie get all cards in
 * project x that are status y."
 *
 * A union of the two tables that can carry a state rather than a query per kind,
 * because the answer is one list: "what is blocked here" is a question about the
 * project, and an agent that had to merge two pages itself would be writing this
 * function again, worse.
 *
 * Ordered by when the state last moved, falling back to when the card was
 * written for the ones marked before migration 037 existed. That is the order
 * the question is asked in — what has just changed — and it matches the feed.
 */
export function listWork(db: Db, query: WorkQuery = {}): WorkRow[] {
	const { projectIds, statuses, limit = 50 } = query;
	if (projectIds?.length === 0) return [];

	const states = statuses ?? CARD_STATUSES;
	if (states.length === 0) return [];

	const marks = states.map(() => '?').join(', ');
	const scope = projectIds ? `AND project_id IN (${projectIds.map(() => '?').join(', ')})` : '';
	const params = [...states, ...(projectIds ?? [])];

	return db
		.prepare<unknown[], RawWork>(
			// `moved_at` is a named output column rather than the expression itself:
			// SQLite will not order a compound SELECT by something that is not in the
			// result set, and both halves have to agree on the name.
			`SELECT 'update' AS kind, id, project_id, status, status_at, created_at, title, body,
			        'agent:' || agent_id AS author, COALESCE(status_at, created_at) AS moved_at
			   FROM updates
			  WHERE status IN (${marks}) AND deleted_at IS NULL ${scope}
			  UNION ALL
			 SELECT 'message' AS kind, id, project_id, status, status_at, created_at, NULL AS title,
			        body, author, COALESCE(status_at, created_at) AS moved_at
			   FROM messages
			  WHERE status IN (${marks}) AND deleted_at IS NULL ${scope}
			  ORDER BY moved_at DESC, id DESC
			  LIMIT ?`
		)
		.all(...params, ...params, limit)
		.map((row) => ({
			kind: row.kind,
			id: row.id,
			projectId: row.project_id,
			status: row.status,
			statusAt: row.status_at,
			createdAt: row.created_at,
			title: row.title,
			body: row.body,
			author: row.author
		}));
}
