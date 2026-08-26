/**
 * `await_request` (design §5) — carry on waiting for an answer.
 *
 * The other half of the bounded long-poll. It exists because a wait cannot live
 * in a socket: MCP clients time out tool calls long before a human necessarily
 * answers, so `request_input` returns `pending` and the agent resumes here — as
 * many times as it takes, and from a fresh process if it crashed in between.
 *
 * There is no agent argument, here least of all: the request being resumed must
 * be the caller's own, and the domain refuses one that belongs to another agent
 * (design §5).
 */
import { awaitRequest } from '$domain';
import { z } from 'zod';
import { guarded, requestResult } from '../results';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from './types';

const inputSchema = {
	request_id: z
		.string()
		.describe('The request_id request_input gave you, or a previous await_request call.')
};

export const awaitRequestTool: McpTool<typeof inputSchema, Promise<CallToolResult>> = {
	name: 'await_request',
	config: {
		title: 'Keep waiting for your owner to answer',
		description: [
			'Resume waiting for an answer to a request you already made with request_input. Call this',
			'whenever request_input — or a previous await_request — answered with state "pending".',
			'',
			'Argument: request_id, the id you were given. It must be one of your own requests.',
			'',
			'It parks for up to 55 seconds and returns exactly what request_input returns:',
			'',
			'  { "state": "answered", "request_id", "response": { "kind", "value" }, "answered_at" }',
			'  { "state": "pending",  "request_id", "poll_after_ms" }',
			'  { "state": "timeout",  "request_id" }',
			'  { "state": "cancelled", "request_id" }',
			'',
			'KEEP CALLING IT WHILE state IS "pending". That loop is the wait: each call is another',
			'55 seconds parked, and there is no cost to going round again. Stop when state is',
			'"answered", "timeout" or "cancelled".',
			'',
			'This works after a restart, and from a process that never made the request: the request',
			'lives in the dashboard database rather than in a connection, so the id is all you need',
			'to pick the wait back up.',
			'',
			'"timeout" means nobody answered in time; "cancelled" means your owner dismissed the',
			'prompt. Neither is permission — do not proceed as though you had an answer.',
			'',
			'On failure: "not_found" means no request has that id, and "invalid_argument" means it',
			'belongs to another agent.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
	},

	run: ({ ctx, agent, holdMs }, args) =>
		guarded(async () =>
			requestResult(
				// Identity comes from the token: an id copied from another agent is
				// refused rather than resumed (design §5).
				await awaitRequest(ctx, { requestId: args.request_id, agentId: agent.id }, { holdMs })
			)
		)
};
