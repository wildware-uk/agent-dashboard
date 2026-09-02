/**
 * Acknowledgements: an agent answering a message or a task without words
 * (migration 013).
 *
 * ## What this is for
 *
 * The owner types a reply and then looks at a card that has not changed. An
 * agent may have read it and started work, or be wedged, or never have
 * connected — and the dashboard shows the same thing in all three cases. That
 * silence is the whole problem this solves, and it is why the vocabulary is two
 * words rather than a status field somebody would have to design.
 *
 * - `thinking` — "I have this, I am on it." A claim about *now*: it is only
 *   true while the agent is alive, so the dashboard shows it only while that
 *   agent is online (`src/web/`). An animation still running against an agent
 *   that died an hour ago is worse than no acknowledgement at all, because it
 *   is a lie the owner has no way to check.
 * - `read` — "I have seen this." Also a fact about the past, and the smallest
 *   thing an agent can honestly say.
 * - `done` — "this is finished." A fact about the past, so it stays put whether
 *   or not the agent is still there.
 *
 * ## What it deliberately is not
 *
 * It is not a message. There is no body — an agent with something to say has
 * `post_message`, and a status vocabulary that grows past the point where a
 * glance decodes it has stopped being a glance.
 *
 * `read` is the one word that has been added since, and it was added because
 * two states were not being used as designed: agents reach for `thinking` and
 * leave it there, because `done` sounds like a claim about the *work* and they
 * are reluctant to make it about a message. So they said nothing at all, which
 * is the silence this whole feature exists to end. "I have seen this" is the
 * smaller, truer thing, and an agent will say it.
 *
 * It is also not a task state. `complete_task` is what finishes work; a `done`
 * acknowledgement on a task says "I have dealt with what you asked me here",
 * which is a different and smaller claim — an owner's note on a task is
 * frequently answered without the task itself finishing.
 */
import {
	findAgentById,
	findMessageById,
	findTaskById,
	listAcknowledgements as listAcknowledgementRows,
	upsertAcknowledgement,
	type AckState,
	type Acknowledgement
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';

/** The three things an agent may say. Nothing here accepts anything else. */
export const ACK_STATES: readonly AckState[] = ['thinking', 'read', 'done'];

export type AcknowledgeInput = {
	/** From the bearer token, never an argument on the wire (design §5). */
	agentId: string;
	/** Exactly one of these two. */
	messageId?: string | null;
	taskId?: string | null;
	state: AckState;
};

/**
 * Record what an agent is saying about one message or one task.
 *
 * Idempotent by construction: there is one row per (agent, thing), so calling
 * this twice with `thinking` is one acknowledgement and calling it again with
 * `done` revises the same one. An agent that loses its connection mid-job can
 * therefore re-assert `thinking` on every reconnect without leaving a trail.
 *
 * @throws {DomainError} `invalid_argument` when neither target or both are
 *   named, or the state is not one of the two; `not_found` for an agent,
 *   message or task that does not exist.
 */
export function acknowledge(ctx: DomainContext, input: AcknowledgeInput): Acknowledgement {
	const messageId = input.messageId ?? null;
	const taskId = input.taskId ?? null;

	// Exactly one, checked here rather than in the row layer: which shapes are
	// legal is a rule about the product, and the table only knows how to store
	// what it is handed.
	if (messageId === null && taskId === null) {
		throw invalid('acknowledge a message or a task: name one of them');
	}
	if (messageId !== null && taskId !== null) {
		throw invalid('acknowledge a message or a task, not both');
	}
	if (!ACK_STATES.includes(input.state)) {
		throw invalid(`state must be one of: ${ACK_STATES.join(', ')}`);
	}

	if (!findAgentById(ctx.db, input.agentId)) {
		throw notFound(`no such agent: ${input.agentId}`);
	}
	// Checked before the write, so an acknowledgement cannot be filed against
	// something that was deleted between the agent reading it and answering it.
	if (messageId !== null && !findMessageById(ctx.db, messageId)) {
		throw notFound(`no such message: ${messageId}`);
	}
	if (taskId !== null && !findTaskById(ctx.db, taskId)) {
		throw notFound(`no such task: ${taskId}`);
	}

	const ack = upsertAcknowledgement(ctx.db, {
		agentId: input.agentId,
		messageId,
		taskId,
		state: input.state,
		at: ctx.now()
	});

	ctx.bus.publish('ack.updated', {
		ackId: ack.id,
		agentId: ack.agentId,
		messageId: ack.messageId,
		taskId: ack.taskId,
		state: ack.state
	});

	return ack;
}

export type AcknowledgementScope = {
	messageIds?: readonly string[];
	taskIds?: readonly string[];
};

/**
 * The acknowledgements on the things a page is about to render.
 *
 * Owner-facing: it rides with the thread and the board rather than being
 * fetched per card, for the same reason the media does — a lookup per message
 * is a fan-out that grows with the conversation.
 */
export function acknowledgementsFor(
	ctx: DomainContext,
	scope: AcknowledgementScope
): Acknowledgement[] {
	return listAcknowledgementRows(ctx.db, scope);
}
