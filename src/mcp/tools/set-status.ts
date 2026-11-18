/**
 * `set_status` (migration 035) — marking a card as work, and moving it along.
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card, in progress, done, blocked
 * etc."
 *
 * This replaces the five task tools. A task used to be a second kind of thing in
 * a second place, with its own page and its own half of every feature; work is
 * now a state a card is in, and a card that is work keeps its thread, its
 * pictures, its reactions and its pin.
 *
 * **Anybody may move it**, unlike editing, which is only ever your own words.
 * Work is shared: the owner writes "deploy the fee service", one agent marks it
 * `in_progress`, and another that finds the deploy stuck marks it `blocked`.
 */
import { CARD_STATUSES, oneCard, setStatus, type CardStatus } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	update_id: z
		.string()
		.optional()
		.describe('The update to mark, from post_update. Name exactly one card.'),
	message_id: z
		.string()
		.optional()
		.describe(
			'A post to mark instead, from get_messages or a channel event — including one your ' +
				'owner wrote straight into the feed, which is how they ask for work now.'
		),
	status: z
		.enum(CARD_STATUSES)
		.nullable()
		.describe(
			'"todo" (work nobody has started), "in_progress" (you are on it now), "blocked" ' +
				'(something outside this card has to happen first), "done", or "cancelled" (it is ' +
				'not going to happen). null takes the mark off entirely, leaving an ordinary card.'
		)
};

export const setStatusTool: McpTool<typeof inputSchema> = {
	name: 'set_status',
	config: {
		title: 'Mark a card as work, or move it along',
		description: [
			'Mark a card in the feed as work and say where it has got to. This is what the task',
			'board used to be: there is no separate list of tasks any more, so work is an update or',
			'a post with a state on it, and it keeps its thread, its pictures and its reactions.',
			'',
			'Arguments (name exactly one card):',
			'- update_id: an update, from post_update.',
			'- message_id: a post, from get_messages or a channel event. Your owner asking for',
			'  something in the feed is the usual case.',
			'- status (required): "todo", "in_progress", "blocked", "done", "cancelled", or null to',
			'  stop calling it work at all.',
			'',
			'How to use it. When you pick something up, mark it "in_progress" before you start —',
			'that is what tells your owner it is being done rather than sitting there. Mark it',
			'"blocked" the moment something outside the card stops you, and say what in a reply;',
			'a blocked card with no explanation is a card somebody has to come and ask about. Mark',
			'it "done" when it is finished, and post what happened rather than leaving the state to',
			'say it for you.',
			'',
			'Anybody may move a card, not only whoever wrote it: work is shared, and a state only',
			'the author could change would be a board with one person allowed to move the cards.',
			'That is worth respecting rather than exploiting — do not quietly take something',
			'another agent has marked "in_progress".',
			'',
			'A question raised with request_input cannot be marked: it ends by being answered, and',
			'its outcome is that answer rather than a state somebody set.',
			'',
			'Returns { card: { kind, id }, status }.',
			'',
			'On failure: "not_found" means no such card, or one that has been deleted.',
			'"invalid_argument" means you named no card or more than one, a state that is not one of',
			'the five, or a kind that cannot carry one.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const result = setStatus(ctx, {
				card: oneCard({ update: args.update_id, message: args.message_id }),
				status: args.status as CardStatus | null
			});

			return ok(
				result.status === null
					? 'Unmarked. It is an ordinary card again.'
					: `Marked ${result.status.replace('_', ' ')}. Your owner sees it on the card.`,
				{ card: result.card, status: result.status }
			);
		})
};
