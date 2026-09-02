/**
 * `acknowledge` (migration 013) — answer the owner without words.
 *
 * The tool exists because of what a dashboard looks like from the owner's side
 * in the seconds after they type something: identical to how it looked before.
 * They cannot tell "read it, working on it" from "wedged" from "never
 * connected", and the only way an agent could previously say so was to post a
 * message, which costs a line of conversation for what is really a state.
 *
 * So: two words, no body. `thinking` renders as a live "Agent is thinking…",
 * `done` as a tick. Anything an agent wants to *say* still belongs in
 * `post_message`, which is why there is no note argument here — a status that
 * could carry a sentence would become a second message channel, and the two
 * would drift.
 *
 * There is no agent argument, for the same reason nothing else here has one:
 * the acknowledger is resolved from the bearer token (design §5).
 */
import { acknowledge } from '$domain';
import { z } from 'zod';
import { ackView, guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	state: z
		.enum(['thinking', 'done'])
		.describe(
			'What you are telling your owner: "thinking" while you are working on it, which shows ' +
				'as a live "Agent is thinking…" on their screen, or "done" when you have dealt with ' +
				'it, which shows as a tick. Sending "done" over an earlier "thinking" replaces it.'
		),
	message_id: z
		.string()
		.optional()
		.describe(
			'The message you are acknowledging — the message_id from get_messages or from a ' +
				"channel event. That includes your owner's own feed posts, which are messages " +
				'with no update_id and no task_id: acknowledging one is how they see you have read ' +
				'what they wrote. Name this or task_id, never both.'
		),
	task_id: z
		.string()
		.optional()
		.describe(
			'The task you are acknowledging instead, from list_tasks or claim_task. Name this or ' +
				'message_id, never both.'
		)
};

export const acknowledgeTool: McpTool<typeof inputSchema> = {
	name: 'acknowledge',
	config: {
		title: 'Say you have seen it',
		description: [
			'Tell your owner you have picked something up, or finished with it, without writing a',
			'reply. It appears on the message or task itself, live.',
			'',
			'This is what stops a card going silent. The moment your owner types something they are',
			'looking at a screen that cannot tell them whether you read it, so acknowledge it as',
			'soon as you have it — before you start the work, not after.',
			'',
			'Arguments:',
			'- state (required): "thinking" or "done". "thinking" shows an animated "Agent is',
			'  thinking…" and means you are on it right now; "done" shows a tick and means you have',
			'  dealt with it. Send "thinking" when you pick something up and "done" when you finish,',
			'  which replaces it.',
			'- message_id (optional): the message you are acknowledging, from get_messages or from a',
			'  channel event. A post your owner wrote straight into the feed is a message like any',
			'  other, so acknowledge it the same way — that is what puts "… is thinking…" under',
			'  their own words while you work out what they need.',
			'- task_id (optional): the task you are acknowledging instead, from list_tasks or',
			'  claim_task.',
			'',
			'Name exactly one of message_id and task_id.',
			'',
			'IMPORTANT: "thinking" is a claim about right now, and your owner only sees it while you',
			'are online — a session that dies mid-job stops animating rather than lying about being',
			'busy. So finish with "done", and do not leave "thinking" behind as your last word on',
			'something you actually completed.',
			'',
			'It is not a reply, and it is not a task state. Anything you want to *say* goes in',
			'post_message; finishing the work itself is still complete_task. A "done" here means',
			'"I have dealt with what you asked me", which is often true while the task goes on.',
			'',
			'Safe to send more than once: there is one acknowledgement per agent per thing, so',
			're-asserting "thinking" after a reconnect leaves no trail and changes nothing.',
			'',
			'Returns { ack: { id, message_id, task_id, state, created_at, updated_at } }.',
			'`created_at` is when you first acknowledged the thing and `updated_at` when you last',
			'changed what you were saying, so your owner can see "seen instantly, finished twenty',
			'minutes later".',
			'',
			'On failure: "invalid_argument" means you named neither target or both of them, or a',
			'state that is not one of the two. "not_found" means the message or task does not',
			'exist — a deleted message cannot be acknowledged.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const ack = acknowledge(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				messageId: args.message_id,
				taskId: args.task_id,
				state: args.state
			});

			return ok(
				ack.state === 'done'
					? 'Marked done. Your owner sees a tick on it.'
					: 'Acknowledged. Your owner sees that you are on it.',
				{ ack: ackView(ack) }
			);
		})
};
