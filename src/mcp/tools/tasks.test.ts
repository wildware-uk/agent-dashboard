/**
 * The three control-plane tools, driven the way an agent's run drives them
 * (design §5): find work, claim one, report back.
 *
 * One file because one subject — a task's life — and the assertions that matter
 * are about the sequence: what a claim does to a later claim, and what a
 * completion posts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelTask, createProject, createTask, listAgents, listTasks, listUpdates } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { claimTaskTool } from './claim-task';
import { completeTaskTool } from './complete-task';
import { listTasksTool } from './list-tasks';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	createProject(mcp.h, { name: 'Agent Dashboard' });
});

const list = (args: Parameters<typeof listTasksTool.run>[1] = {}) =>
	listTasksTool.run(mcp.deps, args);
const claim = (args: Parameters<typeof claimTaskTool.run>[1]) => claimTaskTool.run(mcp.deps, args);
const complete = (args: Parameters<typeof completeTaskTool.run>[1]) =>
	completeTaskTool.run(mcp.deps, args);

/** Another agent's `ToolDeps`, so a rival can really race for a claim. */
function asRival(name = 'rival') {
	const { agentId } = mcp.mint(name);
	const agent = listAgents(mcp.h).find((candidate) => candidate.id === agentId)!;
	return { ctx: mcp.h, agent };
}

/** A task on the queue, optionally targeted at somebody. */
function aTask(title: string, agentId?: string) {
	return createTask(mcp.h, { project: 'agent-dashboard', title, body: 'the brief', agentId });
}

describe('list_tasks', () => {
	it('lists the queue with everything an agent needs to start work', () => {
		const task = aTask('Ship tasks');

		const result = list();

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			count: 1,
			tasks: [
				{
					id: task.id,
					project_id: task.projectId,
					agent_id: null,
					title: 'Ship tasks',
					body: 'the brief',
					state: 'todo',
					created_at: new Date(task.createdAt).toISOString(),
					claimed_at: null,
					done_at: null,
					result: null
				}
			]
		});
		expect(toolText(result)).toContain('Ship tasks');
	});

	it('says so plainly when there is nothing to do', () => {
		const result = list();

		expect(result.structuredContent).toMatchObject({ count: 0, tasks: [] });
		expect(toolText(result).toLowerCase()).toContain('no tasks');
	});

	it('filters by project and by state', () => {
		createProject(mcp.h, { name: 'Other' });
		aTask('here');
		createTask(mcp.h, { project: 'other', title: 'there' });
		const mine = aTask('claimed one');
		claim({ task_id: mine.id });

		expect(titles(list({ project: 'other' }))).toEqual(['there']);
		expect(titles(list({ state: 'todo' }))).toEqual(['there', 'here']);
		expect(titles(list({ state: 'claimed' }))).toEqual(['claimed one']);
	});

	it('filters to the calling agent with mine, and never to another one', () => {
		const other = mcp.mint('rival').agentId;
		aTask('unassigned');
		aTask('for me', mcp.deps.agent.id);
		aTask('for them', other);

		expect(titles(list({ mine: true }))).toEqual(['for me']);
		// The agent comes from the token, so there is no argument that could ask
		// for somebody else's list (design §5).
		expect(Object.keys(listTasksTool.config.inputSchema)).toEqual(['project', 'state', 'mine']);
	});

	it('reports an unknown project as a tool error with the code', () => {
		expect(list({ project: 'nope' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
	});
});

describe('claim_task', () => {
	it('claims a task on the queue and reports the claim back', () => {
		const task = aTask('Ship tasks');

		const result = claim({ task_id: task.id });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			task: { id: task.id, state: 'claimed', agent_id: mcp.deps.agent.id, title: 'Ship tasks' }
		});
		expect(toolText(result)).toContain('Ship tasks');
		expect(listTasks(mcp.h, { state: 'claimed' })).toHaveLength(1);
	});

	it('tells the loser of a race that it was already claimed, and nothing else changes', () => {
		const task = aTask('The only task');
		const rival = asRival();

		expect(claimTaskTool.run(rival, { task_id: task.id }).isError).toBeUndefined();
		const late = claim({ task_id: task.id });

		expect(late).toMatchObject({ isError: true, structuredContent: { error: 'conflict' } });
		expect(toolText(late)).toContain('already claimed');
		expect(listTasks(mcp.h, { agentId: rival.agent.id })).toHaveLength(1);
	});

	it('refuses a cancelled task, a finished one, and one that never existed', () => {
		const cancelled = aTask('withdrawn');
		const finished = aTask('over');
		claim({ task_id: finished.id });
		complete({ task_id: finished.id, result: 'did it' });
		// The owner withdrew this one in the browser.
		cancelTask(mcp.h, cancelled.id);

		expect(toolText(claim({ task_id: cancelled.id }))).toContain('cancelled');
		expect(toolText(claim({ task_id: finished.id }))).toContain('finished');
		expect(claim({ task_id: 'nope' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
	});

	it('will not claim work the owner targeted at another agent', () => {
		const theirs = aTask('theirs', mcp.mint('rival').agentId);

		expect(claim({ task_id: theirs.id })).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
	});
});

describe('complete_task', () => {
	it('finishes the claim and posts nothing unless asked', () => {
		const task = aTask('Ship tasks');
		claim({ task_id: task.id });

		const result = complete({ task_id: task.id, result: 'shipped in 4 commits' });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			task: { id: task.id, state: 'done', result: 'shipped in 4 commits' },
			update: null
		});
		expect(listUpdates(mcp.h, {}).updates).toEqual([]);
	});

	it('also posts the result to the timeline when post_update is true', () => {
		const task = aTask('Ship tasks');
		claim({ task_id: task.id });

		const result = complete({
			task_id: task.id,
			result: 'shipped in 4 commits',
			post_update: true
		});

		const posted = listUpdates(mcp.h, {}).updates;
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			body: 'shipped in 4 commits',
			level: 'success',
			agentId: mcp.deps.agent.id
		});
		expect(result.structuredContent).toMatchObject({ update: { id: posted[0].id } });
		expect(toolText(result)).toContain('posted');
	});

	it('refuses a task it does not hold, with the code that says which mistake it was', () => {
		const loose = aTask('nobody claimed this');
		const theirs = aTask('theirs');
		claimTaskTool.run(asRival(), { task_id: theirs.id });

		expect(complete({ task_id: loose.id, result: 'x' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'conflict' }
		});
		expect(complete({ task_id: theirs.id, result: 'x' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
		expect(complete({ task_id: 'nope', result: 'x' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
		expect(listUpdates(mcp.h, {}).updates).toEqual([]);
	});
});

function titles(result: ReturnType<typeof list>): string[] {
	const content = result.structuredContent as { tasks: { title: string }[] };
	return content.tasks.map((task) => task.title);
}
