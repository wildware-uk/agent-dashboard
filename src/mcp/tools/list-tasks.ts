/**
 * `list_tasks` (design §5) — what is there to do.
 *
 * A read: nothing is written and nothing is published. `mine` is the argument
 * that would have been an agent id in a less careful design; instead it is a
 * boolean, and the agent it resolves to is the one on the bearer token, so there
 * is no way to ask for somebody else's queue (§5).
 */
import { listTasks } from '$domain';
import { z } from 'zod';
import { guard, ok, taskView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	project: z
		.string()
		.optional()
		.describe(
			'Only tasks in this project: its slug ("agent-dashboard") or its 26-character id, as ' +
				'list_projects returns. Omit for every project.'
		),
	state: z
		.enum(['todo', 'claimed', 'done', 'cancelled'])
		.optional()
		.describe(
			'Only tasks in this state: "todo" is unclaimed and available, "claimed" is being ' +
				'worked on, "done" finished, "cancelled" withdrawn by the owner. Omit for all four.'
		),
	mine: z
		.boolean()
		.optional()
		.describe(
			'True for only the tasks that are yours — ones you have claimed, or that the owner ' +
				'assigned to you. Unclaimed tasks belong to nobody, so they are not included. ' +
				'Defaults to false, which is every task.'
		)
};

export const listTasksTool: McpTool<typeof inputSchema> = {
	name: 'list_tasks',
	config: {
		title: 'List tasks',
		description: [
			'List the work the owner has put on a project. Newest first. Call this to find something',
			'to do, or to check what you are already holding.',
			'',
			'Arguments:',
			'- project (optional): a project slug or its 26-character id. Omit for every project.',
			'- state (optional): "todo", "claimed", "done" or "cancelled". "todo" is what you can',
			'  claim right now.',
			'- mine (optional): true for only your own tasks — claimed by you, or assigned to you by',
			'  the owner. Which agent that means comes from your bearer token; there is deliberately',
			'  no argument for it, so you can never read another agent’s queue.',
			'',
			'Returns { tasks: [{ id, project_id, agent_id, title, body, state, created_at, claimed_at,',
			'done_at, result }], count }. `body` is the brief in full, so a claimable task needs no',
			'second call to read. A task with `agent_id` set and `state` "todo" was assigned to that',
			'agent by the owner and only that agent may claim it.',
			'',
			'An empty list is a normal answer, not an error: there is nothing for you to do. On',
			'failure, "not_found" means the project reference matched nothing — call list_projects.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const tasks = listTasks(ctx, {
				project: args.project,
				state: args.state,
				// `mine` resolves to the token's agent and to nothing else (design §5).
				agentId: args.mine ? agent.id : undefined
			});

			return ok(
				summary(
					tasks.map((task) => task.title),
					args.mine === true
				),
				{
					tasks: tasks.map(taskView),
					count: tasks.length
				}
			);
		})
};

/**
 * The sentence the model reads first.
 *
 * The titles are in it because that is the whole question — "is there anything
 * here for me" — and an agent that has to parse JSON to find out reads the list
 * twice.
 */
function summary(titles: string[], mine: boolean): string {
	if (titles.length === 0) {
		return mine ? 'No tasks are assigned to you. Nothing to do.' : 'No tasks match. Nothing to do.';
	}

	const noun = titles.length === 1 ? 'task' : 'tasks';
	return `${titles.length} ${noun}: ${titles.join('; ')}.`;
}
