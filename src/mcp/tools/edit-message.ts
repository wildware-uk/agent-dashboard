/**
 * `edit_message` (migration 033) — an agent corrects a line it already said.
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 * `edit_update` has existed since migration 006 and the reason is the same one
 * here: a thread where every mistake is followed by "sorry, ignore that" is a
 * thread nobody can skim, and the owner is the one left working out which line
 * is true.
 *
 * Only the agent's own words. The author comes from the bearer token and the
 * domain refuses somebody else's message, which matters more in a thread than
 * on a card: several agents and the owner all write here, and a tool that let
 * one rewrite another's line would make the whole conversation unreliable.
 *
 * Deliberately just the body. The anchor stays (a corrected typo must not move
 * the line to another card), the images and embeds stay, and the ticks stay: an
 * acknowledgement was given for words, and swapping what it was given for would
 * be claiming approval that was never offered.
 */
import { MESSAGE_BODY_MAX_LENGTH, editMessage } from '$domain';
import { z } from 'zod';
import { guard, messageView, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	message_id: z
		.string()
		.describe(
			'The id of the message to edit, as post_message returned it. It must be one of your own.'
		),
	body: z
		.string()
		.max(MESSAGE_BODY_MAX_LENGTH)
		.describe(
			`The replacement text, as markdown, at most ${MESSAGE_BODY_MAX_LENGTH} characters. It ` +
				`replaces the whole message rather than appending to it.`
		)
};

export const editMessageTool: McpTool<typeof inputSchema> = {
	name: 'edit_message',
	config: {
		title: 'Correct something you said',
		description: [
			'Rewrite one of your own messages — a reply on a card, a comment in a task, a line in a',
			"question's discussion. Use it when what you said has stopped being true or was wrong",
			'when you said it: a path you pasted incorrectly, a number that has moved on, a summary',
			'that read worse than you meant.',
			'',
			'Arguments:',
			'- message_id (required): the id post_message returned. Only your own messages.',
			`- body (required): the replacement markdown, at most ${MESSAGE_BODY_MAX_LENGTH}`,
			'  characters. It replaces the message; it does not append to it.',
			'',
			'Prefer this over a second message saying "ignore that". A thread of corrections is one',
			'your owner has to read twice to find out what is true.',
			'',
			'The line stays where it is, keeps its images and its acknowledgements, and is marked as',
			'edited so your owner can see that what they read earlier has changed. There is no',
			'revision history: the new text is the only text. If they have already acted on what you',
			'said, say so in a new message instead — rewriting it silently would leave them holding',
			'a decision they made for reasons that are no longer on screen.',
			'',
			'Returns { message: { id, project_id, update_id, request_id, reply_to, author,',
			'body, created_at, edited_at } }.',
			'',
			'On failure: "not_found" means there is no such message, or it has been deleted — a line',
			'that was unsent cannot be rewritten back into existence. "invalid_argument" means it was',
			'posted by somebody else, or the body was empty or too long. Nothing is written either',
			'way.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const message = editMessage(ctx, {
				messageId: args.message_id,
				// Identity comes from the token, never from `args` (design §5).
				by: { kind: 'agent', agentId: agent.id },
				body: args.body
			});

			return ok('Edited. Your owner sees the new text.', { message: messageView(message) });
		})
};
