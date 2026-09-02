/**
 * `delete_message` (migration 017) — take your own words back.
 *
 * The owner asked for this in the same breath as their own delete, and the two
 * are the same feature seen from either end: a thread is a conversation on
 * somebody's screen, and everybody in it should be able to withdraw a line they
 * wish they had not sent.
 *
 * **Only your own.** The author comes from the bearer token, so there is no
 * argument for who is deleting — an agent that could delete the owner's message
 * could delete the instruction it did not like, and the owner would have no way
 * to tell that from a message they never sent.
 *
 * The delete is soft and it is announced, so the line disappears from every tab
 * that has the thread open rather than only from the next reload.
 */
import { deleteMessage } from '$domain';
import { z } from 'zod';
import { guard, messageView, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	message_id: z
		.string()
		.describe(
			'The message to delete, from post_message or get_messages. It must be one you wrote: ' +
				'this unsends your own words, and nobody else’s.'
		)
};

export const deleteMessageTool: McpTool<typeof inputSchema> = {
	name: 'delete_message',
	config: {
		title: 'Unsend a message you posted',
		description: [
			'Delete a message you posted, so it disappears from your owner’s screen.',
			'',
			'For the line you wish you had not sent: a half-written reply, a duplicate, an answer',
			'that turned out to be wrong before anybody acted on it. It is removed from the thread',
			'live, in every tab that has it open, rather than at the next reload.',
			'',
			'Arguments:',
			'- message_id (required): the message to delete, as returned by post_message or',
			'  get_messages.',
			'',
			'Only your own messages. The author comes from your bearer token, so there is no',
			'argument for who is deleting and no way to delete somebody else’s words — your owner’s',
			'least of all.',
			'',
			'Correcting is usually better than deleting: a reply that was wrong and a reply that was',
			'never sent look the same afterwards, and your owner may have already read it. Delete',
			'noise; answer a mistake.',
			'',
			'Returns { message: { id, project_id, update_id, task_id, reply_to, author, body,',
			'created_at, deleted_at } }. Deleting twice is not an error: the second call returns the',
			'same row and announces nothing.',
			'',
			'On failure: "not_found" means no such message; "invalid_argument" means it was posted by',
			'somebody else.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const message = deleteMessage(ctx, {
				messageId: args.message_id,
				// Identity comes from the token, never from `args` (design §5).
				by: { kind: 'agent', agentId: agent.id }
			});

			return ok('Unsent. It is gone from your owner’s screen.', {
				message: messageView(message)
			});
		})
};
