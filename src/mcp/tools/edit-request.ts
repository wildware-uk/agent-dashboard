/**
 * `edit_request` (migration 033) — the asking agent rewrites its own question.
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 * The case that asks for it is a draft. An agent puts a message in a `form`,
 * spots a mistake in it while the owner is still reading, and without this has
 * to withdraw the question and ask a second one — which throws away anything
 * they had already typed into the field and makes the dashboard stutter.
 *
 * Pending only. An answer is checked against the options the row carried when it
 * was given, so a settled question whose options moved afterwards would make the
 * record disagree with the decision. A question that has ended is history.
 *
 * The kind cannot change: it decides which control the owner is looking at, and
 * swapping buttons for a text box under somebody's cursor is a way to collect an
 * answer to a question they were never shown.
 */
import {
	DETAIL_MAX_LENGTH,
	OPTION_MAX_LENGTH,
	QUESTION_MAX_LENGTH,
	TEXT_ANSWER_MAX_LENGTH,
	editRequest
} from '$domain';
import { z } from 'zod';
import { guard, ok, requestView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	request_id: z
		.string()
		.describe('The request_id request_input gave you. It must be one of your own requests.'),
	question: z
		.string()
		.max(QUESTION_MAX_LENGTH)
		.optional()
		.describe(
			`The replacement question, at most ${QUESTION_MAX_LENGTH} characters. Omit to leave it.`
		),
	detail: z
		.string()
		.max(DETAIL_MAX_LENGTH)
		.nullable()
		.optional()
		.describe(
			`The replacement explanation under the question, at most ${DETAIL_MAX_LENGTH} ` +
				`characters. Omit to leave it; pass null to remove it.`
		),
	options: z
		.array(z.string().max(OPTION_MAX_LENGTH))
		.optional()
		.describe(
			'The replacement options, for the kinds that have them — buttons, choice, multi_choice ' +
				'and a form`s action buttons. Omit to leave them. They replace the whole list, and a ' +
				'kind with no options refuses them.'
		),
	default: z
		.string()
		.max(TEXT_ANSWER_MAX_LENGTH)
		.nullable()
		.optional()
		.describe(
			'The replacement pre-filled value: for a form, the draft in the field — this is the one ' +
				'to use when you have spotted a mistake in what you drafted. Omit to leave it; pass ' +
				'null to clear it.'
		)
};

export const editRequestTool: McpTool<typeof inputSchema> = {
	name: 'edit_request',
	config: {
		title: 'Correct a question you are waiting on',
		description: [
			'Rewrite a request_input prompt that is still waiting for an answer. Use it when the',
			'question was wrong or has moved on while you waited: a draft with a mistake in it, an',
			'option that turned out not to be available, an explanation that missed something your',
			'owner needs in order to decide.',
			'',
			'Arguments:',
			'- request_id (required): the id request_input gave you. Yours only.',
			`- question (optional): the replacement question, at most ${QUESTION_MAX_LENGTH}`,
			'  characters.',
			`- detail (optional): the replacement explanation, at most ${DETAIL_MAX_LENGTH}`,
			'  characters, or null to remove it.',
			'- options (optional): the replacement options, for buttons, choice, multi_choice and a',
			'  form`s action buttons. Replaces the whole list.',
			'- default (optional): the replacement pre-filled value — for a form, the draft sitting',
			'  in the field. Null clears it.',
			'',
			'At least one of them must be given. The kind cannot change: it decides which control',
			'your owner is looking at. If that is what is wrong, withdraw_request and ask again.',
			'',
			'Your wait is unaffected. Nothing is settled by an edit, so keep the await_request loop',
			'running exactly as before. The card stays where it is and is marked as edited, because',
			'an owner half way through deciding has to be able to see that the question moved.',
			'',
			'One thing to weigh: your owner may already be typing into that field. Editing the',
			'default replaces what is on their screen only if they have not touched it — but a',
			'question that changes under somebody mid-answer is disorienting, so if they have',
			'started, prefer to say what changed in a reply on the question (post_message with its',
			'request_id) and leave the prompt alone.',
			'',
			'Returns { request: { id, kind, question, detail, options, project_id, update_id,',
			'message_id, expires_at } }.',
			'',
			'On failure: "not_found" means no request has that id; "invalid_argument" means it is not',
			'yours, that you passed values this kind does not take, or that you changed nothing;',
			'"conflict" means it has already ended — answered, dismissed, withdrawn or timed out.',
			'A conflict is worth reading rather than retrying: if they answered while you were',
			'editing, that answer stands and await_request will give it to you.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const request = editRequest(ctx, {
				requestId: args.request_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				question: args.question,
				detail: args.detail,
				options: args.options,
				default: args.default
			});

			return ok(`Edited "${request.question}". Your owner sees the new question.`, {
				request: requestView(request)
			});
		})
};
