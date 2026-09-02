/**
 * `post_message` (design §5, §7) — answer the owner where they asked.
 *
 * The other half of `get_messages`, and until this existed the conversation was
 * one-way: the owner could reply on a card and the agent could only answer by
 * posting a *new* update, which reads as ignoring them and buries the exchange
 * somewhere other than where it started.
 *
 * **A reply is not an update.** `post_update` announces something that happened
 * and takes a level, a priority and media; this puts a line in a thread that is
 * already on screen. Using an update for a reply is what makes a timeline of
 * "as discussed" cards nobody can follow.
 *
 * The anchor is the argument that matters. `update_id` or `task_id` — never
 * both — puts the message in that thread, which is where the owner is looking;
 * `project` alone is a note in the project's conversation. A reply that named
 * neither would land in a thread the owner has to go and find.
 *
 * There is no author argument, deliberately and for the same reason no other
 * tool has one: the writer is resolved from the bearer token, so an agent can
 * only ever speak as itself (§5).
 */
import { postMessage } from '$domain';
import { z } from 'zod';
import { guard, messageView, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	body: z
		.string()
		.describe(
			'What to say, as markdown. Raw HTML is shown as text, never executed. This is a line in a conversation, so write it as one.'
		),
	update_id: z
		.string()
		.optional()
		.describe(
			'The update whose thread this belongs in — normally the update_id off the message you are answering, so your reply appears under it on the same card.'
		),
	task_id: z
		.string()
		.optional()
		.describe(
			'The task whose thread this belongs in. A message hangs off an update or a task, never both.'
		),
	message_id: z
		.string()
		.optional()
		.describe(
			"The owner's own post to answer, from get_messages or a channel event — a post that " +
				'names no update and no task is one they wrote straight into the feed. Reply to the ' +
				'post itself, never to another reply.'
		),
	project: z
		.string()
		.optional()
		.describe(
			'A project slug or id, for a note that answers no particular card. Derived from the update or task when you name one, so you rarely need it.'
		),
	media_ids: z
		.array(z.string())
		.optional()
		.describe(
			'Images or video to show on this reply: ids from create_upload whose bytes you have ' +
				'already PUT. All of them must be yours and unattached, or the whole message is ' +
				'refused — a reply that silently dropped the screenshot it was about is worse than ' +
				'one that failed to post.'
		)
};

export const postMessageTool: McpTool<typeof inputSchema> = {
	name: 'post_message',
	config: {
		title: 'Reply to your owner',
		description: [
			'Reply to your owner in a thread — normally the one you were just read a message from.',
			'It appears on their screen live, under the card they were looking at.',
			'',
			'Use this rather than post_update to *answer* something. An update announces what',
			'happened and gets its own card; a message is a line in a conversation already on',
			'screen. Answering a reply with a new update reads as ignoring it.',
			'',
			'Arguments:',
			'- body (required): what to say, as markdown, at most 10000 characters.',
			'- update_id (optional): the update to reply under. Pass the `update_id` from the',
			'  message you are answering and your reply lands on the same card.',
			'- task_id (optional): the task to reply on instead. A message hangs off an update or a',
			'  task, never both.',
			"- message_id (optional): the owner's own feed post to answer. They can write straight",
			'  into the timeline, and such a post hangs off no update and no task — it *is* the thing',
			'  being discussed, so a reply names it. You may also name a reply — including one your',
			'  owner wrote inside a thread — and your answer is filed under the same post, so a thread',
			'  is always one level deep.',
			'- project (optional): a slug or id, for a note that answers no card. Taken from the',
			'  update or task when you name one.',
			'- media_ids (optional): images to show on the reply, from create_upload with their bytes',
			'  already uploaded. Answer with the screenshot rather than describing it.',
			'',
			'Returns { message: { id, project_id, update_id, task_id, reply_to, author, body,',
			'created_at } }.',
			'`author` is your own `agent:<agent_id>`: the writer comes from your bearer token, so you',
			'can only ever post as yourself.',
			'',
			'On failure: "not_found" means the update, task, message or project matched nothing — a',
			'deleted update is gone rather than silently re-anchored. "invalid_argument" means an',
			'empty or over-long body, that you named more than one of update_id, task_id and',
			'message_id, or that you named a project that disagrees with the one the anchor belongs',
			'to.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const message = postMessage(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				author: { kind: 'agent', agentId: agent.id },
				body: args.body,
				updateId: args.update_id,
				taskId: args.task_id,
				replyTo: args.message_id,
				project: args.project,
				mediaIds: args.media_ids
			});

			return ok('Replied. It is on your owner’s screen now.', {
				message: messageView(message)
			});
		})
};
