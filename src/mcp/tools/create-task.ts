/**
 * `create_task` (design §5, §7) — an agent puts work on the board.
 *
 * Tasks were owner-created only, which assumed the owner is the one who knows
 * what needs doing. Often they are not: an agent halfway through a migration
 * discovers three follow-ups, and the choice without this tool is to bury them
 * in an update nobody can track or to stop and ask. Both are worse than a task.
 *
 * `agent_id` is deliberately an argument rather than the caller's own identity,
 * and it is the one place in this surface where that is true. Everywhere else
 * the token says who you are, and there is no argument for it (§5). Here the
 * caller is saying who the work is *for*: an agent that found something it will
 * do itself passes its own id, and one that found something for the fleet passes
 * nothing and leaves it on the queue.
 */
import { TASK_BODY_MAX_LENGTH, TASK_TITLE_MAX_LENGTH, createTask } from '$domain';
import { z } from 'zod';
import { guard, ok, taskView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	project: z
		.string()
		.describe(
			'Which project the work belongs to: its slug ("agent-dashboard") or its 26-character ' +
				'id, as create_project and list_projects return.'
		),
	title: z
		.string()
		.max(TASK_TITLE_MAX_LENGTH)
		.describe(
			`One line saying what needs doing, at most ${TASK_TITLE_MAX_LENGTH} characters. This ` +
				`is what your owner reads on the board, so write the outcome ("migrate the parser ` +
				`off the legacy tokeniser") rather than the symptom ("tokeniser is weird").`
		),
	body: z
		.string()
		.max(TASK_BODY_MAX_LENGTH)
		.optional()
		.describe(
			`The brief: what you found, why it needs doing, anything the next agent would have to ` +
				`rediscover. At most ${TASK_BODY_MAX_LENGTH} characters. Whoever claims this reads ` +
				`it instead of asking you.`
		),
	assign_to_me: z
		.boolean()
		.optional()
		.describe(
			'True to put your own name on it, for work you found and intend to do. Leave it off to ' +
				'put it on the queue for whichever agent claims it first — which is the right choice ' +
				'for anything you are not about to start.'
		)
};

export const createTaskTool: McpTool<typeof inputSchema> = {
	name: 'create_task',
	config: {
		title: 'Put work on the board',
		description: [
			'Add a task to a project: a long-running piece of work, tracked on your owner’s board',
			'until somebody finishes it. Use it when you discover something that needs doing and is',
			'not what you are doing now — follow-ups from a migration, a flaky test worth chasing,',
			'a thing you had to skip.',
			'',
			'Arguments:',
			'- project (required): the slug or the 26-character id.',
			`- title (required): one line, at most ${TASK_TITLE_MAX_LENGTH} characters.`,
			`- body (optional): the brief, at most ${TASK_BODY_MAX_LENGTH} characters.`,
			'- assign_to_me (optional): true to take it yourself; leave it off to queue it.',
			'',
			'A task is not an update. An update is something that happened and scrolls away; a task',
			'is outstanding until it is done, and it has a page showing every update filed against',
			'it. If you are about to work on this, claim it and pass its id as `task_id` to',
			'post_update as you go — a claimed task with no updates looks stalled.',
			'',
			'Do not create a task for something you are finishing in the next minute. The board is',
			'for work that outlives the run that found it.',
			'',
			'Returns { task: { id, project_id, agent_id, title, body, state, created_at, claimed_at,',
			'done_at, result } }. `state` is "todo", and `agent_id` is you when you asked for it.',
			'',
			'On failure: "not_found" means the project reference matched nothing — call',
			'list_projects. "invalid_argument" means the title was empty or something was too long.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const task = createTask(ctx, {
				project: args.project,
				title: args.title,
				body: args.body,
				// The one argument-shaped identity in this surface, and only ever the
				// caller's own id: an agent cannot put work in another agent's name.
				agentId: args.assign_to_me ? agent.id : null
			});

			return ok(
				`Added task "${task.title}" to ${args.project}${args.assign_to_me ? ', assigned to you' : ''}.`,
				{ task: taskView(task) }
			);
		})
};
