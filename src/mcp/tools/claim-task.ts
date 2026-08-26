/**
 * `claim_task` (design §5) — take one task off the queue.
 *
 * The tool that has to be right under contention. The domain does it in a single
 * conditional `UPDATE ... WHERE state='todo'` (`src/domain/tasks.ts`), so of two
 * agents reaching for the same task one gets the claim and the other gets a
 * `conflict` saying it was already claimed. Nothing here retries on the agent's
 * behalf: the honest answer is "somebody else has it, pick another", and the
 * description says exactly that.
 */
import { claimTask } from '$domain';
import { z } from 'zod';
import { guard, ok, taskView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	task_id: z
		.string()
		.describe('The 26-character id of the task to claim, as list_tasks returns it.')
};

export const claimTaskTool: McpTool<typeof inputSchema> = {
	name: 'claim_task',
	config: {
		title: 'Claim a task',
		description: [
			'Take a "todo" task and make it yours. Claiming is how the owner sees that somebody',
			'picked the work up, and it stops a second agent starting the same job.',
			'',
			'Arguments:',
			'- task_id (required): the id from list_tasks.',
			'',
			'The claim is a single atomic write, so if two agents reach for the same task at the same',
			'moment exactly one of them gets it. You become the claimant; there is no argument for',
			'who claims it, because that comes from your bearer token.',
			'',
			'Returns { task: { id, project_id, agent_id, title, body, state, created_at, claimed_at,',
			'done_at, result } } with state "claimed" and agent_id set to you. Work the brief in',
			'`body`, then call complete_task with what you did.',
			'',
			'On failure: "conflict" means the task is not available — another agent claimed it first,',
			'it is already finished, or the owner cancelled it. That is not a retryable error: call',
			'list_tasks with state "todo" and claim a different one. "invalid_argument" means the',
			'owner assigned this task to a specific other agent, so it is not yours to take.',
			'"not_found" means there is no task with that id.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const task = claimTask(ctx, {
				taskId: args.task_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id
			});

			return ok(`Claimed task "${task.title}" as agent "${agent.name}".`, {
				task: taskView(task)
			});
		})
};
