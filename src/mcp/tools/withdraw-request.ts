/**
 * `withdraw_request` (migration 031) — taking back a question nobody needs
 * answered any more.
 *
 * The owner asked for this in the case that names itself: a question that has
 * stopped being relevant. Until now an agent could raise a prompt and had no way
 * to take it down — it asked "shall I retry the deploy?", watched the deploy
 * succeed, and the question sat on the owner's banner waiting for a decision
 * that no longer existed.
 *
 * There is no agent argument, here least of all: the request being withdrawn
 * must be the caller's own, and the domain refuses one that belongs to another
 * agent (design §5). Otherwise an id copied from anywhere would let one agent
 * silence another's question.
 */
import { withdrawRequest } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	request_id: z
		.string()
		.describe('The request_id request_input gave you. It must be one of your own requests.')
};

export const withdrawRequestTool: McpTool<typeof inputSchema> = {
	name: 'withdraw_request',
	config: {
		title: 'Take back a question you no longer need answered',
		description: [
			'Take down a request_input prompt you raised, because the question has stopped mattering.',
			'',
			'Use it the moment that happens rather than leaving the prompt up. A question on your',
			"owner's banner is a claim that you are blocked on it, and one that has gone stale costs",
			'them a decision they no longer have to make — which is worse than not having asked.',
			'',
			'The usual case is that the world moved while you were waiting: you asked whether to retry',
			'the deploy and it went green on its own, you asked which of two files to edit and the',
			'answer became obvious, you asked for a value and then found it. If you are still blocked,',
			'do not withdraw — keep waiting with await_request.',
			'',
			'Arguments:',
			'- request_id (required): the id request_input gave you. Yours only.',
			'',
			'Withdrawing is not the same as being refused. Your owner is not told you did it — there is',
			'nothing for them to do — and the request is recorded as withdrawn rather than dismissed,',
			'so the history says the question stopped mattering rather than that they declined it.',
			'',
			'Returns { request_id, state: "withdrawn" }. On failure: "not_found" means no request has',
			'that id; "invalid_argument" means it is not yours; "conflict" means it had already ended —',
			'your owner answered it, they dismissed it, or it timed out. A conflict is worth reading',
			'rather than retrying: if they answered while you were withdrawing, that answer stands and',
			'await_request will give it to you.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const request = withdrawRequest(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				requestId: args.request_id
			});

			return ok(`Withdrew "${request.question}". It is off your owner's dashboard.`, {
				request_id: request.id,
				state: 'withdrawn'
			});
		})
};
