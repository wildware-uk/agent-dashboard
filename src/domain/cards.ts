/**
 * The features every card shares (migration 034).
 *
 * The owner: "there are many discrepancies between the card types, they should
 * all share the same features, and be implemented in a generic modular fashion,
 * we need to do a refactor."
 *
 * Four things appear in the feed — an update, one of the owner's own posts, a
 * question, a task — and the features that cut across them used to be written
 * once per card that happened to need them first. Pinning existed only on
 * updates, reactions only on messages, acknowledgements only on messages and
 * tasks. None of that was a decision; it was the order the features were built
 * in.
 *
 * This module is where those features live now. It takes a {@link CardRef} — a
 * kind and an id — and does the same thing whatever the kind is. The row layer
 * points at the card through one nullable column per kind (`$db/cards.ts`), and
 * the only per-kind knowledge left in the product is two maps there and
 * {@link cardEvent} below.
 *
 * What is deliberately *not* generic: what a card says. An update has a level
 * and a title, a question has options and a deadline, a task has a state. Those
 * live in their own modules because they are what makes each kind different.
 */
import {
	CARD_KINDS,
	CARD_STATUSES,
	addReaction,
	findAgentById,
	findCard,
	listAcknowledgements as listAcknowledgementRows,
	listReactions as listReactionRows,
	listWork,
	removeReaction,
	countOpenWork,
	setCardPinned,
	setCardStatus,
	upsertAcknowledgement,
	type AckState,
	type Acknowledgement,
	type CardKind,
	type CardRef,
	type CardRow,
	type CardStatus,
	type Reaction,
	type WorkRow
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { authorText, projectsForAgent, type MessageAuthor } from './messages';
import { resolveProject } from './projects';
import { assertEmoji } from './reactions';

export {
	CARD_KINDS,
	CARD_STATUSES,
	isCardKind,
	isCardStatus,
	type CardKind,
	type CardRef,
	type CardStatus
} from '$db';

/** The kinds that can be marked as work (migration 035). */
const WORKABLE: readonly CardKind[] = ['update', 'message'];

/** The three things an agent may say without words. Nothing accepts any other. */
export const ACK_STATES: readonly AckState[] = ['thinking', 'read', 'done'];

/**
 * The one card a caller named, out of an argument per kind.
 *
 * Tools and routes take `message_id`, `update_id`, `request_id`, `task_id`
 * rather than a `{ kind, id }` object, because an agent writing a tool call is
 * better served by four named arguments than by a pair it has to get right
 * together. Exactly one of them, checked here so every caller refuses the same
 * way in the same words.
 */
export function oneCard(named: Partial<Record<CardKind, string | null | undefined>>): CardRef {
	const given = CARD_KINDS.flatMap((kind) => {
		const id = named[kind]?.trim();
		return id ? [{ kind, id }] : [];
	});

	if (given.length === 0) throw invalid(`name one of: ${CARD_KINDS.join(', ')}`);
	if (given.length > 1) {
		throw invalid(`name one of: ${CARD_KINDS.join(', ')} — not ${given.length} of them`);
	}
	return given[0];
}

/**
 * The card, or a refusal naming the kind the caller asked for.
 *
 * One place, so "no such card" reads the same wherever a feature is used, and a
 * deleted card is as absent as one that never existed — an emoji on a line the
 * owner unsent would be a reaction nobody can see attached to words nobody can
 * read.
 */
export function resolveCard(ctx: DomainContext, card: CardRef): CardRow {
	const row = findCard(ctx.db, card);
	if (!row || row.deletedAt !== null) throw notFound(`no such ${card.kind}: ${card.id}`);
	return row;
}

/**
 * Announce that a card changed, in the vocabulary its own readers already
 * watch.
 *
 * Rather than one `card.updated` event: every browser store is subscribed to
 * the events for the kind it renders, and a new name would mean teaching four
 * stores a fifth word to learn something three of them do not care about.
 */
export function announceCard(ctx: DomainContext, card: CardRef, row: CardRow): void {
	announce(ctx, card, row);
}

function announce(ctx: DomainContext, card: CardRef, row: CardRow): void {
	if (card.kind === 'update') {
		ctx.bus.publish('update.updated', {
			updateId: card.id,
			projectId: row.projectId ?? '',
			pinned: row.pinned
		});
		return;
	}
	if (card.kind === 'message') {
		ctx.bus.publish('message.updated', {
			messageId: card.id,
			projectId: row.projectId,
			author: ''
		});
		return;
	}
	ctx.bus.publish('request.updated', {
		requestId: card.id,
		agentId: '',
		projectId: row.projectId
	});
}

/**
 * Pin a card to the top of the feed, or unpin it.
 *
 * The owner's control on every kind, which is what they asked for: "let me pin
 * my own messages". It was an update's alone because updates were the only
 * cards when it was written, and a feed where one kind of thing can be kept in
 * view and the others cannot is a feed that decides for them what matters.
 *
 * Idempotent: pinning what is already pinned changes nothing and announces
 * nothing, so a double click is one pin.
 */
export function pinCard(
	ctx: DomainContext,
	input: { card: CardRef; pinned: boolean }
): { card: CardRef; pinned: boolean } {
	const row = resolveCard(ctx, input.card);
	if (row.pinned === input.pinned) return { card: input.card, pinned: row.pinned };

	const saved = setCardPinned(ctx.db, input.card, input.pinned);
	if (!saved) throw notFound(`no such ${input.card.kind}: ${input.card.id}`);

	announce(ctx, input.card, saved);
	return { card: input.card, pinned: saved.pinned };
}

/**
 * Mark a card as work, move it along, or stop calling it work (migration 035).
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card, in progress, done, blocked
 * etc." So work is not a second kind of thing any more — it is a state a card is
 * in, and a card that is work keeps everything a card has: its thread, its
 * pictures, its reactions, its pin.
 *
 * **Anybody may move it.** Unlike editing, which is only ever your own words,
 * work is shared: the owner writes "deploy the fee service", an agent picks it
 * up and marks it `in_progress`, and a second agent that finds the deploy is
 * stuck marks it `blocked`. A state nobody but the author could change would be
 * a board with one person allowed to move the cards.
 *
 * `null` clears it, which is how a card marked by mistake goes back to being an
 * ordinary card.
 *
 * @throws {DomainError} `not_found` for a card that does not exist or has been
 *   deleted; `invalid_argument` for a state that is not one of the five, or for
 *   a kind that cannot carry one — a question ends by being answered, and its
 *   outcome is the answer rather than a state somebody set.
 */
export function setStatus(
	ctx: DomainContext,
	input: { card: CardRef; status: CardStatus | null }
): { card: CardRef; status: CardStatus | null } {
	if (!WORKABLE.includes(input.card.kind)) {
		throw invalid(`a ${input.card.kind} cannot be marked as work`);
	}
	if (input.status !== null && !CARD_STATUSES.includes(input.status)) {
		throw invalid(`status must be one of: ${CARD_STATUSES.join(', ')}`);
	}

	const row = resolveCard(ctx, input.card);
	if (row.status === input.status) return { card: input.card, status: row.status };

	const saved = setCardStatus(ctx.db, input.card, input.status, ctx.now());
	if (!saved) throw notFound(`no such ${input.card.kind}: ${input.card.id}`);

	announce(ctx, input.card, saved);
	return { card: input.card, status: saved.status };
}

/**
 * How much open work there is, in the projects a session cares about
 * (migration 035).
 *
 * This is what `open_tasks` counts now. The name on the wire is unchanged on
 * purpose: an agent's channel bridge is whatever code it started with, and
 * renaming a field would make every running session read zero.
 *
 * Scoped exactly as unread messages are, and for the same reason — a session
 * that said it is working on one project must not be woken by another's work.
 *
 * - a **list** — only those projects.
 * - **`null`** — every project, asked for explicitly.
 * - **`undefined`** — no opinion, so work it out from what this agent has done.
 */
export function countOpenWorkInScope(
	ctx: DomainContext,
	agentId: string,
	subscribed?: readonly string[] | null
): number {
	const projectIds = subscribed === undefined ? projectsForAgent(ctx, agentId) : subscribed;
	return countOpenWork(ctx.db, projectIds ?? undefined);
}

/** How much of a card's own words the work list carries. */
export const WORK_SUMMARY_CHARS = 240;

/** What {@link listWorkInScope} is asked for. */
export type WorkScope = {
	/** A project slug or id. Omitted means every project the caller may see. */
	project?: string | null;
	/** The states wanted. Omitted means every card that carries one. */
	statuses?: readonly CardStatus[];
	/** At most this many, newest movement first. */
	limit?: number;
};

/** One card on the work list, as an agent reads it. */
export type WorkItem = {
	kind: CardKind;
	id: string;
	projectId: string | null;
	status: CardStatus;
	/** When the state last moved, or `null` for one marked before migration 037. */
	statusAt: number | null;
	createdAt: number;
	title: string | null;
	/** The first {@link WORK_SUMMARY_CHARS} characters of what the card says. */
	summary: string;
	author: string;
};

/**
 * The work in a project, filtered by state (migration 035).
 *
 * The owner: "allow agents to filter cards by work status, ie get all cards in
 * project x that are status y."
 *
 * The dashboard could already do this — the feed grew filter chips — and an
 * agent could not, which left "what is blocked here" as a question only a human
 * could ask. This is the same question against the same rows.
 *
 * Scoped the way unread messages are when no project is named: what this agent
 * has actually worked in. An agent that has done nothing anywhere sees
 * everything, which is the same rule `get_messages` uses so a new agent is not
 * blind on its first run. Naming a project asks for that one, and an unknown
 * reference is `not_found` rather than an empty list — "there is no such
 * project" and "there is nothing to do" are different answers.
 *
 * @throws {DomainError} `not_found` for a project reference that matches
 *   nothing, `invalid_argument` for a state that is not one of the five.
 */
export function listWorkInScope(
	ctx: DomainContext,
	agentId: string,
	scope: WorkScope = {}
): WorkItem[] {
	for (const status of scope.statuses ?? []) {
		if (!CARD_STATUSES.includes(status)) {
			throw invalid(`${JSON.stringify(status)} is not a work state`);
		}
	}

	const projectIds = scope.project
		? [resolveProject(ctx, scope.project).id]
		: (projectsForAgent(ctx, agentId) ?? undefined);

	return listWork(ctx.db, {
		...(projectIds ? { projectIds } : {}),
		...(scope.statuses ? { statuses: scope.statuses } : {}),
		...(scope.limit === undefined ? {} : { limit: scope.limit })
	}).map(summarise);
}

function summarise(row: WorkRow): WorkItem {
	const words = row.body.trim();
	return {
		kind: row.kind,
		id: row.id,
		projectId: row.projectId,
		status: row.status,
		statusAt: row.statusAt,
		createdAt: row.createdAt,
		title: row.title,
		summary: words.length > WORK_SUMMARY_CHARS ? `${words.slice(0, WORK_SUMMARY_CHARS)}…` : words,
		author: row.author
	};
}

export type ReactToCardInput = {
	card: CardRef;
	/** From the session cookie or the bearer token, never an argument (§5). */
	actor: MessageAuthor;
	emoji: string;
	/**
	 * `true` to react, `false` to take it back, and omitted to toggle.
	 *
	 * Toggling is what a click means. A caller that knows which it wants is
	 * better off saying so: a retry after a dropped connection would otherwise
	 * undo the reaction it thought it was making.
	 */
	on?: boolean;
};

export type ReactResult = {
	reactions: Reaction[];
	/** Whether the reaction is on the card now. */
	on: boolean;
	/** Whether this call changed anything, so only a change publishes. */
	changed: boolean;
};

/**
 * React to any card, or take a reaction back.
 *
 * @throws {DomainError} `not_found` for a card that does not exist or has been
 *   deleted; `invalid_argument` for something that is not an emoji.
 */
export function reactToCard(ctx: DomainContext, input: ReactToCardInput): ReactResult {
	const row = resolveCard(ctx, input.card);

	const emoji = assertEmoji(input.emoji);
	const actor = authorText(input.actor);
	const already = listReactionRows(ctx.db, input.card.kind, [input.card.id]).some(
		(reaction) => reaction.actor === actor && reaction.emoji === emoji
	);
	const wanted = input.on ?? !already;

	let changed = false;
	if (wanted && !already) {
		changed = addReaction(ctx.db, { card: input.card, actor, emoji, at: ctx.now() }).created;
	} else if (!wanted && already) {
		changed = removeReaction(ctx.db, { card: input.card, actor, emoji });
	}

	if (changed) {
		// Announced so every open tab and every watching agent sees it land; quiet
		// when nothing moved, because an event saying the state is what it already
		// was is a refetch for nothing.
		ctx.bus.publish('reaction.updated', {
			card: input.card,
			messageId: input.card.kind === 'message' ? input.card.id : null,
			projectId: row.projectId,
			actor,
			emoji,
			on: wanted
		});
	}

	return {
		reactions: listReactionRows(ctx.db, input.card.kind, [input.card.id]),
		on: wanted,
		changed
	};
}

/** Every reaction on a page of cards of one kind, for the browser rendering them. */
export function reactionsForCards(
	ctx: DomainContext,
	kind: CardKind,
	ids: readonly string[]
): Reaction[] {
	return listReactionRows(ctx.db, kind, ids);
}

export type AcknowledgeCardInput = {
	/** From the bearer token, never an argument on the wire (design §5). */
	agentId: string;
	card: CardRef;
	state: AckState;
};

/**
 * Record what an agent is saying about a card without saying it in words.
 *
 * Idempotent by construction: one row per (agent, card), so calling this twice
 * with `thinking` is one acknowledgement and calling it again with `done`
 * revises the same one. An agent that loses its connection mid-job can re-assert
 * `thinking` on every reconnect without leaving a trail.
 *
 * @throws {DomainError} `not_found` for an agent or a card that does not exist;
 *   `invalid_argument` for a state that is not one of the three.
 */
export function acknowledgeCard(ctx: DomainContext, input: AcknowledgeCardInput): Acknowledgement {
	if (!ACK_STATES.includes(input.state)) {
		throw invalid(`state must be one of: ${ACK_STATES.join(', ')}`);
	}
	if (!findAgentById(ctx.db, input.agentId)) {
		throw notFound(`no such agent: ${input.agentId}`);
	}
	// Checked before the write, so an acknowledgement cannot be filed against
	// something that went away between the agent reading it and answering it.
	resolveCard(ctx, input.card);

	const ack = upsertAcknowledgement(ctx.db, {
		agentId: input.agentId,
		card: input.card,
		state: input.state,
		at: ctx.now()
	});

	ctx.bus.publish('ack.updated', {
		ackId: ack.id,
		agentId: ack.agentId,
		card: input.card,
		messageId: ack.messageId,
		taskId: ack.taskId,
		state: ack.state
	});

	return ack;
}

/**
 * Which cards a page is about to render, by kind.
 *
 * A map rather than a field per kind, so a fifth card type is a line in
 * `CARD_KINDS` and nothing here.
 */
export type AcknowledgementScope = Partial<Record<CardKind, readonly string[]>>;

/**
 * The acknowledgements on the things a page is about to render.
 *
 * Owner-facing: they ride with the thread and the board rather than being
 * fetched per card, for the same reason the media does — a lookup per message is
 * a fan-out that grows with the conversation.
 */
export function acknowledgementsFor(
	ctx: DomainContext,
	scope: AcknowledgementScope
): Acknowledgement[] {
	return listAcknowledgementRows(ctx.db, scope);
}
