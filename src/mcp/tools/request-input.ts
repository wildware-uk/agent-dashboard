/**
 * `request_input` (design §5) — stop and ask your owner something.
 *
 * One tool, five kinds, because what an agent needs from a human depends
 * entirely on the work it was given: a missing value, permission, a choice
 * between actions, one option, or several. Permission is one shape of asking,
 * not the whole of it.
 *
 * The mechanism is the part that has to be right, and it is entirely in the
 * description below: this call parks for at most `HOLD_S` and then hands back
 * `state: "pending"`, and **the agent is what turns that into a wait** by
 * calling `await_request` in a loop. There is no push channel to a stateless
 * MCP server (`../server.ts`), so this description is the contract. It is
 * written for an agent that has never seen this server before.
 */
import { requestInput, type RequestKind } from '$domain';
import { z } from 'zod';
import { guarded, requestResult } from '../results';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from './types';

const inputSchema = {
	kind: z
		.enum(['text', 'confirm', 'buttons', 'choice', 'multi_choice'])
		.describe(
			'What you need back: "text" for a string, "confirm" for a yes/no, "buttons" for one ' +
				'action out of several, "choice" for one option from a list, "multi_choice" for any ' +
				'number of options.'
		),
	question: z
		.string()
		.describe(
			'The one line your owner reads, phrased as a question they can answer without reading ' +
				'your transcript. Up to 500 characters.'
		),
	detail: z
		.string()
		.optional()
		.describe(
			'The paragraph under the question: what you found, what you are about to do, why you ' +
				'stopped. Up to 4000 characters. Markdown is not rendered here.'
		),
	options: z
		.array(z.string())
		.optional()
		.describe(
			'The options offered, for kind "buttons", "choice" and "multi_choice". Required for ' +
				'those three, refused for the others. Distinct, at most 25, 200 characters each. ' +
				'The answer you get back is one of these exact strings.'
		),
	placeholder: z
		.string()
		.optional()
		.describe('kind "text" only: the hint shown in the empty box, e.g. "fix: the parser".'),
	multiline: z
		.boolean()
		.optional()
		.describe('kind "text" only: true gives your owner a textarea rather than a single line.'),
	default: z
		.string()
		.optional()
		.describe(
			'Pre-fills the control: the suggested text for "text", one of the options for ' +
				'"buttons" and "choice", "true" or "false" for "confirm". Not accepted for ' +
				'"multi_choice".'
		),
	min: z
		.number()
		.int()
		.optional()
		.describe(
			'kind "multi_choice": the fewest options that may be chosen. kind "text": the shortest ' +
				'answer, in characters. Not accepted for the other kinds.'
		),
	max: z
		.number()
		.int()
		.optional()
		.describe(
			'kind "multi_choice": the most options that may be chosen. kind "text": the longest ' +
				'answer, in characters (10000 by default). Not accepted for the other kinds.'
		),
	project: z
		.string()
		.optional()
		.describe('A project slug or id, so the prompt says what this is about.'),
	update: z
		.string()
		.optional()
		.describe(
			'The id of the update this follows from, if you just posted one. Supplies the project ' +
				'when you omit it.'
		),
	timeout_s: z
		.number()
		.int()
		.optional()
		.describe(
			'How long the request stays answerable, in seconds. Defaults to 3600 (one hour); ' +
				'between 5 and 86400. After it passes the state becomes "timeout" and no answer ' +
				'can arrive.'
		)
};

export const requestInputTool: McpTool<typeof inputSchema, Promise<CallToolResult>> = {
	name: 'request_input',
	config: {
		title: 'Ask your owner for something and wait',
		description: [
			'Stop and ask the human who owns this dashboard for something only they can supply, then',
			'wait for the answer. The prompt appears immediately in a banner at the top of their',
			'dashboard, above everything else, with the control your `kind` calls for.',
			'',
			'Pick the kind by what you need back:',
			'- kind "text" -> a string. A commit message, a name, a value you are missing.',
			'  Optional placeholder, multiline, default, min and max (character bounds).',
			'- kind "confirm" -> true or false. Permission to do something consequential.',
			'- kind "buttons" -> one of your options. "retry" / "skip" / "abort".',
			'- kind "choice" -> one of your options, chosen from a list.',
			'- kind "multi_choice" -> a list of your options. Use min and max to bound how many.',
			'',
			'Arguments: kind and question are required. detail is the longer explanation.',
			'options is required for buttons, choice and multi_choice and refused for the rest.',
			'placeholder, multiline, default, min, max are the kind-specific knobs listed above.',
			'project (a slug or id) and update (an update id) say what the request is about.',
			'timeout_s is how long the request stays answerable, one hour by default.',
			'',
			'HOW THE WAITING WORKS. READ THIS BEFORE YOU CALL IT.',
			'',
			'A human is slower than your tool timeout, so this call does not hold open until they',
			'click. It parks for up to 55 seconds and then returns one of these:',
			'',
			'  { "state": "answered", "request_id", "response": { "kind", "value" }, "answered_at" }',
			'  { "state": "pending",  "request_id", "poll_after_ms" }',
			'  { "state": "timeout",  "request_id" }',
			'  { "state": "cancelled", "request_id" }',
			'',
			'If state is "pending" NOBODY HAS ANSWERED YET AND YOU ARE NOT FINISHED WAITING. Call',
			'await_request({ request_id }) with the id you were given, and keep calling it for as',
			'long as it keeps answering "pending". Each call parks for another 55 seconds, so a loop',
			'of them costs nothing while it waits. Stop looping only when state is "answered",',
			'"timeout" or "cancelled".',
			'',
			'The wait survives your own restart: the request lives in the dashboard database, not in',
			'this connection. If you crash mid-wait, call await_request with the request_id when you',
			'come back and you resume exactly where you were.',
			'',
			'READING THE ANSWER. `response.value` is typed by `response.kind`: a string for "text",',
			'"buttons" and "choice"; true or false for "confirm"; an array of strings for',
			'"multi_choice". Narrow on `response.kind` and the value is whichever of those it says.',
			'The server checks every answer against the request that asked for it, so a "choice"',
			'value is always one of the options you offered and a "multi_choice" always respects your',
			'min and max — you do not need to re-validate it.',
			'',
			'"timeout" means nobody answered in time and "cancelled" means your owner dismissed the',
			'prompt. NEITHER IS PERMISSION. Do not do the thing you asked about; post an update',
			'saying you are blocked, or stop.',
			'',
			'On failure: "invalid_argument" means the request contradicts itself — options on a',
			'confirm, a choice with no options, a min above its max — and the message says which.',
			'"not_found" means the project or update you named does not exist.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
	},

	run: ({ ctx, agent, holdMs }, args) =>
		guarded(async () =>
			requestResult(
				await requestInput(
					ctx,
					{
						// Identity comes from the token, never from `args` (design §5).
						agentId: agent.id,
						kind: args.kind as RequestKind,
						question: args.question,
						detail: args.detail,
						options: args.options,
						placeholder: args.placeholder,
						multiline: args.multiline,
						default: args.default,
						min: args.min,
						max: args.max,
						project: args.project,
						update: args.update,
						timeoutS: args.timeout_s
					},
					{ holdMs }
				)
			)
		)
};
