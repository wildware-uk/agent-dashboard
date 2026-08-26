/**
 * `complete_task` (design §5) — report back and close the claim.
 *
 * `post_update` exists because the two things an agent wants to do at the end of
 * a job — mark it done, and tell the owner what happened — are one intention. It
 * is optional rather than automatic: ten small tasks finishing in a row would
 * bury the timeline, and the agent is the only one who knows which kind this was.
 * When it is true the update is posted by the same agent, into the task's own
 * project, at level "success".
 */
import { TASK_RESULT_MAX_LENGTH, completeTask } from '$domain';
import { z } from 'zod';
import { guard, ok, taskView, updateView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	task_id: z
		.string()
		.describe('The 26-character id of the task you claimed, as claim_task returned it.'),
	result: z
		.string()
		.max(TASK_RESULT_MAX_LENGTH)
		.describe(
			`What you did, for the owner to read, at most ${TASK_RESULT_MAX_LENGTH} characters. ` +
				`A couple of sentences beats a transcript.`
		),
	post_update: z
		.boolean()
		.optional()
		.describe(
			'True to also post the result to the project timeline as a "success" update, so the ' +
				'owner sees it in the feed rather than only on the task. Defaults to false — leave it ' +
				'off for small tasks you would not want to fill the feed with.'
		)
};

export const completeTaskTool: McpTool<typeof inputSchema> = {
	name: 'complete_task',
	config: {
		title: 'Complete a task',
		description: [
			'Finish a task you claimed, recording what you did. Only the agent holding the claim can',
			'complete it, and that is taken from your bearer token rather than from an argument.',
			'',
			'Arguments:',
			'- task_id (required): the task you claimed.',
			`- result (required): what you did, at most ${TASK_RESULT_MAX_LENGTH} characters. The`,
			'  owner reads this, so write it for a person.',
			'- post_update (optional): true to also post `result` to the project timeline as a',
			'  "success" update. Use it when the work is worth a card in the feed; leave it off for',
			'  routine tasks.',
			'',
			'Returns { task: { id, project_id, agent_id, title, body, state, created_at, claimed_at,',
			'done_at, result }, update }. `task.state` is "done". `update` is the posted update when',
			'you asked for one — { id, project_id, agent_id, session_id, title, level, pinned,',
			'body_chars, created_at } — and null when you did not.',
			'',
			'On failure: "conflict" means the task is not claimed — you never claimed it, or it is',
			'already finished or cancelled — so nothing was recorded and nothing was posted.',
			'"invalid_argument" means another agent holds the claim, or the result was empty or too',
			'long. "not_found" means there is no task with that id.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const { task, update } = completeTask(ctx, {
				taskId: args.task_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				result: args.result,
				postUpdate: args.post_update
			});

			const posted = update === null ? '' : ' The result was posted to the timeline.';
			return ok(`Completed task "${task.title}".${posted}`, {
				task: taskView(task),
				update: update === null ? null : updateView(update)
			});
		})
};
