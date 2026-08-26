import { describe, expect, it } from 'vitest';
import { findTaskById, insertTask, listTasks as listTaskRows } from '$db';
import { createProject } from './projects';
import { heartbeat, registerSession } from './sessions';
import { listUpdates } from './updates';
import { isDomainError, type DomainError } from './errors';
import { harness, FIXED_NOW, type Harness } from './testing';
import {
	TASK_MAX_LIMIT,
	assignTask,
	cancelTask,
	claimTask,
	completeTask,
	countOpenTasks,
	createTask,
	listTasks
} from './tasks';

/** A project and an agent: what every task needs before it can exist. */
function setup(h: Harness = harness()) {
	const { project } = createProject(h, { name: 'Agent Dashboard' });
	return { h, project, agentId: h.agent('scout') };
}

/** The code of a `DomainError` a call threw, or the failure of not throwing. */
function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	return 'no error thrown';
}

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	return 'no error thrown';
}

describe('createTask', () => {
	it('creates an unassigned todo task and announces it', () => {
		const { h, project } = setup();

		const task = createTask(h, { project: project.slug, title: '  Ship tasks  ', body: 'do it' });

		expect(task).toMatchObject({
			projectId: project.id,
			agentId: null,
			title: 'Ship tasks',
			body: 'do it',
			state: 'todo',
			createdAt: FIXED_NOW,
			claimedAt: null,
			doneAt: null,
			result: null
		});
		expect(h.events.at(-1)).toMatchObject({
			type: 'task.created',
			payload: { taskId: task.id, projectId: project.id, agentId: null, state: 'todo' }
		});
	});

	it('targets one agent when the owner asks for one (design §7)', () => {
		const { h, project, agentId } = setup();

		const task = createTask(h, { project: project.slug, title: 'Yours', agentId });

		expect(task).toMatchObject({ agentId, state: 'todo' });
		expect(h.events.at(-1)?.payload).toMatchObject({ agentId });
	});

	it('takes a project id as readily as a slug', () => {
		const { h, project } = setup();

		expect(createTask(h, { project: project.id, title: 'By id' }).projectId).toBe(project.id);
	});

	it('refuses an unknown project, an unknown agent and a blank title', () => {
		const { h, project, agentId } = setup();

		expect(codeOf(() => createTask(h, { project: 'nope', title: 'x' }))).toBe('not_found');
		expect(codeOf(() => createTask(h, { project: project.slug, title: '   ' }))).toBe(
			'invalid_argument'
		);
		expect(
			codeOf(() => createTask(h, { project: project.slug, title: 'x', agentId: 'ghost' }))
		).toBe('not_found');
		// Nothing was written, and nothing was announced, for any of the three.
		expect(listTaskRows(h.db)).toEqual([]);
		expect(h.eventNames()).toEqual(['project.created']);
		expect(agentId).toBeTruthy();
	});
});

describe('listTasks', () => {
	it('filters by project, state and assignee, newest first', () => {
		const { h, project, agentId } = setup();
		const other = createProject(h, { name: 'Other' }).project;
		const mine = createTask(h, { project: project.slug, title: 'mine', agentId });
		createTask(h, { project: project.slug, title: 'loose' });
		createTask(h, { project: other.slug, title: 'elsewhere' });
		claimTask(h, { taskId: mine.id, agentId });

		expect(listTasks(h, { project: project.slug }).map((task) => task.title)).toEqual([
			'loose',
			'mine'
		]);
		expect(listTasks(h, { agentId }).map((task) => task.title)).toEqual(['mine']);
		expect(listTasks(h, { state: 'todo' }).map((task) => task.title)).toEqual([
			'elsewhere',
			'loose'
		]);
	});

	it('caps the page rather than trusting a caller-supplied limit', () => {
		const { h, project } = setup();
		for (let index = 0; index < 3; index += 1) {
			createTask(h, { project: project.slug, title: `t${index}` });
		}

		expect(listTasks(h, { limit: TASK_MAX_LIMIT + 5000 })).toHaveLength(3);
		expect(listTasks(h, { limit: 1 })).toHaveLength(1);
		expect(codeOf(() => listTasks(h, { limit: 0 }))).toBe('invalid_argument');
	});

	it('refuses an unknown project rather than widening to every task', () => {
		const { h } = setup();

		expect(codeOf(() => listTasks(h, { project: 'nope' }))).toBe('not_found');
	});
});

describe('claimTask', () => {
	it('claims a todo task and announces the new state', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'Ship it' });

		const claimed = claimTask(h, { taskId: task.id, agentId });

		expect(claimed).toMatchObject({ state: 'claimed', agentId, claimedAt: FIXED_NOW });
		expect(h.events.at(-1)).toMatchObject({
			type: 'task.updated',
			payload: { taskId: task.id, projectId: project.id, agentId, state: 'claimed' }
		});
	});

	it('produces exactly one winner when five agents race for one task', async () => {
		const { h, project } = setup();
		const task = createTask(h, { project: project.slug, title: 'The only task' });
		const racers = [0, 1, 2, 3, 4].map((index) => h.agent(`racer-${index}`));

		const winners: string[] = [];
		const losers: DomainError[] = [];
		await Promise.all(
			racers.map(async (agentId) => {
				// Yield first, so the five calls are interleaved by the runtime rather
				// than run in the order they were written.
				await Promise.resolve();
				try {
					winners.push(claimTask(h, { taskId: task.id, agentId }).agentId!);
				} catch (error) {
					losers.push(error as DomainError);
				}
			})
		);

		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(4);
		// Every loser is told the same clean thing, and none of them corrupted the
		// row: the task is claimed once, by the one winner.
		for (const error of losers) {
			expect(error.code).toBe('conflict');
			expect(error.message).toMatch(/already claimed/);
		}
		expect(findTaskById(h.db, task.id)).toMatchObject({ state: 'claimed', agentId: winners[0] });
		// And exactly one claim was announced, so no browser saw a second owner.
		expect(h.eventNames().filter((name) => name === 'task.updated')).toEqual(['task.updated']);
	});

	it('tells a late claimant clearly what happened, whatever the state is', () => {
		const { h, project, agentId } = setup();
		const claimed = createTask(h, { project: project.slug, title: 'taken' });
		claimTask(h, { taskId: claimed.id, agentId: h.agent('first') });
		const cancelled = createTask(h, { project: project.slug, title: 'dropped' });
		cancelTask(h, cancelled.id);
		const finished = createTask(h, { project: project.slug, title: 'over' });
		claimTask(h, { taskId: finished.id, agentId });
		completeTask(h, { taskId: finished.id, agentId, result: 'done' });

		expect(messageOf(() => claimTask(h, { taskId: claimed.id, agentId }))).toMatch(
			/already claimed/
		);
		expect(messageOf(() => claimTask(h, { taskId: cancelled.id, agentId }))).toMatch(/cancelled/);
		expect(messageOf(() => claimTask(h, { taskId: finished.id, agentId }))).toMatch(
			/already (finished|done)/
		);
		expect(codeOf(() => claimTask(h, { taskId: 'nope', agentId }))).toBe('not_found');
	});

	it('leaves a task assigned to somebody else alone', () => {
		const { h, project, agentId } = setup();
		const theirs = createTask(h, { project: project.slug, title: 'theirs', agentId });
		const intruder = h.agent('intruder');

		expect(codeOf(() => claimTask(h, { taskId: theirs.id, agentId: intruder }))).toBe(
			'invalid_argument'
		);
		expect(findTaskById(h.db, theirs.id)).toMatchObject({ state: 'todo', agentId });
	});

	it('lets the agent it was assigned to claim it', () => {
		const { h, project, agentId } = setup();
		const mine = createTask(h, { project: project.slug, title: 'mine', agentId });

		expect(claimTask(h, { taskId: mine.id, agentId })).toMatchObject({ state: 'claimed', agentId });
	});
});

describe('completeTask', () => {
	it('finishes the claim it holds and announces it', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'Ship it' });
		claimTask(h, { taskId: task.id, agentId });

		const { task: done, update } = completeTask(h, {
			taskId: task.id,
			agentId,
			result: '  shipped in 4 commits  '
		});

		expect(done).toMatchObject({
			state: 'done',
			result: 'shipped in 4 commits',
			doneAt: FIXED_NOW
		});
		expect(update).toBeNull();
		expect(h.events.at(-1)).toMatchObject({
			type: 'task.updated',
			payload: { taskId: task.id, state: 'done', agentId }
		});
	});

	it('posts the result to the timeline when asked (design §5)', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'Ship it' });
		claimTask(h, { taskId: task.id, agentId });

		const { update } = completeTask(h, {
			taskId: task.id,
			agentId,
			result: 'shipped it',
			postUpdate: true
		});

		expect(update).toMatchObject({
			projectId: project.id,
			agentId,
			body: 'shipped it',
			level: 'success'
		});
		expect(update?.title).toContain('Ship it');
		expect(listUpdates(h, {}).updates.map((row) => row.id)).toEqual([update!.id]);
		expect(h.eventNames()).toContain('update.created');
	});

	it('refuses a task nobody claimed, and one claimed by somebody else', () => {
		const { h, project, agentId } = setup();
		const loose = createTask(h, { project: project.slug, title: 'loose' });
		const theirs = createTask(h, { project: project.slug, title: 'theirs' });
		claimTask(h, { taskId: theirs.id, agentId: h.agent('other') });

		expect(codeOf(() => completeTask(h, { taskId: loose.id, agentId, result: 'x' }))).toBe(
			'conflict'
		);
		expect(codeOf(() => completeTask(h, { taskId: theirs.id, agentId, result: 'x' }))).toBe(
			'invalid_argument'
		);
		expect(codeOf(() => completeTask(h, { taskId: 'nope', agentId, result: 'x' }))).toBe(
			'not_found'
		);
		expect(findTaskById(h.db, loose.id)?.state).toBe('todo');
		// A refused completion posts nothing: the update would outlive the claim.
		expect(h.eventNames()).not.toContain('update.created');
	});

	it('requires a result worth reading', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'Ship it' });
		claimTask(h, { taskId: task.id, agentId });

		expect(codeOf(() => completeTask(h, { taskId: task.id, agentId, result: '  ' }))).toBe(
			'invalid_argument'
		);
		expect(findTaskById(h.db, task.id)?.state).toBe('claimed');
	});
});

describe('cancelTask and assignTask', () => {
	it('cancels a task the owner has changed its mind about, once', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'never mind' });

		expect(cancelTask(h, task.id)).toMatchObject({ state: 'cancelled', doneAt: FIXED_NOW });
		expect(h.events.at(-1)).toMatchObject({
			type: 'task.updated',
			payload: { taskId: task.id, state: 'cancelled' }
		});
		expect(codeOf(() => cancelTask(h, task.id))).toBe('conflict');
		expect(codeOf(() => cancelTask(h, 'nope'))).toBe('not_found');
		expect(codeOf(() => claimTask(h, { taskId: task.id, agentId }))).toBe('conflict');
	});

	it('assigns and unassigns an open task, announcing each change', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'somebody' });

		expect(assignTask(h, task.id, agentId)).toMatchObject({ agentId, state: 'todo' });
		expect(h.events.at(-1)).toMatchObject({
			type: 'task.updated',
			payload: { taskId: task.id, agentId, state: 'todo' }
		});
		expect(assignTask(h, task.id, null)).toMatchObject({ agentId: null });
		expect(codeOf(() => assignTask(h, task.id, 'ghost'))).toBe('not_found');
	});

	it('will not reassign work that is already over', () => {
		const { h, project, agentId } = setup();
		const task = createTask(h, { project: project.slug, title: 'over' });
		cancelTask(h, task.id);

		expect(codeOf(() => assignTask(h, task.id, agentId))).toBe('conflict');
	});
});

describe('countOpenTasks', () => {
	it('counts this agent`s todo and claimed rows, and nobody else`s', () => {
		const { h, project, agentId } = setup();
		const other = h.agent('other');
		createTask(h, { project: project.slug, title: 'mine todo', agentId });
		const claimed = createTask(h, { project: project.slug, title: 'mine claimed', agentId });
		claimTask(h, { taskId: claimed.id, agentId });
		const finished = createTask(h, { project: project.slug, title: 'mine done', agentId });
		claimTask(h, { taskId: finished.id, agentId });
		completeTask(h, { taskId: finished.id, agentId, result: 'done' });
		createTask(h, { project: project.slug, title: 'unassigned' });
		createTask(h, { project: project.slug, title: 'theirs', agentId: other });

		expect(countOpenTasks(h, agentId)).toBe(2);
		expect(countOpenTasks(h, other)).toBe(1);
	});

	it('is what a heartbeat reports, so an agent discovers work without polling', () => {
		const { h, project, agentId } = setup();
		const { session } = registerSession(h, { agentId });

		expect(heartbeat(h, { sessionId: session.id, agentId }).openTasks).toBe(0);

		createTask(h, { project: project.slug, title: 'for you', agentId });

		expect(heartbeat(h, { sessionId: session.id, agentId })).toMatchObject({
			ok: true,
			openTasks: 1,
			unreadMessages: 0,
			pendingApprovals: 0
		});
	});
});

describe('the insert this domain does not do', () => {
	it('leaves a directly inserted row visible, so a fixture needs no domain call', () => {
		const { h, project } = setup();
		insertTask(h.db, { projectId: project.id, title: 'raw' });

		expect(listTasks(h, { project: project.slug }).map((task) => task.title)).toEqual(['raw']);
	});
});
