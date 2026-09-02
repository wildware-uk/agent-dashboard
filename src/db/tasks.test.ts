import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import {
	assignTask,
	broadcastTask,
	cancelTask,
	claimTask,
	completeTask,
	countBroadcastTasks,
	findTaskById,
	insertTask,
	listTasks
} from './tasks';

let db: Db;
let projectId: string;
let agentId: string;
beforeEach(() => {
	db = freshDatabase();
	projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
});

const todo = (over: Partial<Parameters<typeof insertTask>[1]> = {}) =>
	insertTask(db, { projectId, title: 'do it', ...over });

describe('insertTask', () => {
	it('starts unassigned in the todo state', () => {
		const task = todo();

		expect(task).toMatchObject({
			projectId,
			agentId: null,
			title: 'do it',
			body: '',
			state: 'todo',
			claimedAt: null,
			doneAt: null,
			result: null
		});
	});

	it('can be created already assigned to an agent', () => {
		expect(todo({ agentId })).toMatchObject({ agentId, state: 'todo' });
	});

	it('rejects a state outside the design enumeration', () => {
		expect(() => todo({ state: 'blocked' as 'todo' })).toThrow(/CHECK/);
	});
});

describe('claimTask', () => {
	it('is atomic: exactly one of two racing claims wins', () => {
		const task = todo();
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;

		const first = claimTask(db, task.id, agentId, 100);
		const second = claimTask(db, task.id, other, 101);

		expect(first).toMatchObject({ state: 'claimed', agentId, claimedAt: 100 });
		expect(second).toBeUndefined();
		expect(findTaskById(db, task.id)).toMatchObject({ agentId });
	});

	it('will not claim a task that is done or cancelled', () => {
		const done = todo();
		claimTask(db, done.id, agentId, 1);
		completeTask(db, done.id, { result: 'ok', at: 2 });
		const cancelled = todo();
		cancelTask(db, cancelled.id, 3);

		expect(claimTask(db, done.id, agentId, 4)).toBeUndefined();
		expect(claimTask(db, cancelled.id, agentId, 4)).toBeUndefined();
	});

	it('reports nothing for an unknown task', () => {
		expect(claimTask(db, 'nope', agentId)).toBeUndefined();
	});
});

describe('completeTask', () => {
	it('records the result and the time', () => {
		const task = todo();
		claimTask(db, task.id, agentId, 100);

		expect(completeTask(db, task.id, { result: 'shipped', at: 200 })).toMatchObject({
			state: 'done',
			result: 'shipped',
			doneAt: 200
		});
	});

	it('refuses to complete a task nobody claimed', () => {
		const task = todo();

		expect(completeTask(db, task.id, { result: 'x' })).toBeUndefined();
	});

	it('refuses to complete another agent`s task when the claimant is named', () => {
		const task = todo();
		claimTask(db, task.id, agentId, 100);
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;

		expect(completeTask(db, task.id, { result: 'x', agentId: other })).toBeUndefined();
		expect(completeTask(db, task.id, { result: 'x', agentId })).toMatchObject({ state: 'done' });
	});
});

describe('cancelTask', () => {
	it('cancels a todo or claimed task, once', () => {
		const task = todo();

		expect(cancelTask(db, task.id, 500)).toMatchObject({ state: 'cancelled', doneAt: 500 });
		expect(cancelTask(db, task.id, 600)).toBeUndefined();
	});

	it('will not cancel a finished task', () => {
		const task = todo();
		claimTask(db, task.id, agentId, 1);
		completeTask(db, task.id, { result: 'ok', at: 2 });

		expect(cancelTask(db, task.id, 3)).toBeUndefined();
	});
});

describe('assignTask', () => {
	it('sets and clears the assignee', () => {
		const task = todo();

		expect(assignTask(db, task.id, agentId)).toMatchObject({ agentId });
		expect(assignTask(db, task.id, null)).toMatchObject({ agentId: null });
		expect(assignTask(db, 'nope', agentId)).toBeUndefined();
	});
});

describe('listTasks', () => {
	it('filters by project, state and assignee, newest first', () => {
		const other = insertProject(db, { slug: 'q', name: 'Q' }).id;
		const mine = todo({ title: 'mine' });
		claimTask(db, mine.id, agentId, 1);
		todo({ title: 'open' });
		insertTask(db, { projectId: other, title: 'elsewhere' });

		expect(listTasks(db, { projectId }).map((t) => t.title)).toEqual(['open', 'mine']);
		expect(listTasks(db, { state: 'todo' }).map((t) => t.title)).toEqual(['elsewhere', 'open']);
		expect(listTasks(db, { agentId }).map((t) => t.title)).toEqual(['mine']);
		expect(listTasks(db, { projectId, state: 'claimed' }).map((t) => t.title)).toEqual(['mine']);
	});

	it('honours a limit', () => {
		todo();
		todo();

		expect(listTasks(db, { limit: 1 })).toHaveLength(1);
	});
});

describe('broadcastTask', () => {
	it('stamps when the task went out to the project', () => {
		const task = todo();

		expect(broadcastTask(db, task.id, 500)).toMatchObject({ id: task.id, broadcastAt: 500 });
		expect(findTaskById(db, task.id)?.broadcastAt).toBe(500);
	});

	it('takes it back off the wire when the stamp is cleared', () => {
		const task = todo();
		broadcastTask(db, task.id, 500);

		expect(broadcastTask(db, task.id, null)?.broadcastAt).toBeNull();
	});

	it('refuses work somebody already holds, so nobody is sent to lose a race', () => {
		const task = todo();
		claimTask(db, task.id, agentId);

		expect(broadcastTask(db, task.id, 500)).toBeUndefined();
		expect(findTaskById(db, task.id)?.broadcastAt).toBeNull();
	});

	it('answers undefined for a task that is not there', () => {
		expect(broadcastTask(db, 'nope', 500)).toBeUndefined();
	});
});

describe('countBroadcastTasks', () => {
	it('counts only unassigned todo work that was actually sent out', () => {
		broadcastTask(db, todo().id, 1);
		// Not broadcast at all.
		todo();
		// Broadcast, then claimed: no longer going spare.
		const claimed = todo();
		broadcastTask(db, claimed.id, 1);
		claimTask(db, claimed.id, agentId);
		// Broadcast, then assigned to somebody by name.
		const assigned = todo();
		broadcastTask(db, assigned.id, 1);
		assignTask(db, assigned.id, agentId);

		expect(countBroadcastTasks(db)).toBe(1);
	});

	it('narrows to the projects it is given', () => {
		const other = insertProject(db, { slug: 'other', name: 'Other' }).id;
		broadcastTask(db, todo().id, 1);
		broadcastTask(db, insertTask(db, { projectId: other, title: 'theirs' }).id, 1);

		expect(countBroadcastTasks(db, [projectId])).toBe(1);
		expect(countBroadcastTasks(db, [projectId, other])).toBe(2);
	});

	it('counts nothing for an empty list, because "these projects" is not "all of them"', () => {
		broadcastTask(db, todo().id, 1);

		expect(countBroadcastTasks(db, [])).toBe(0);
	});
});

describe('listTasks with a broadcast filter', () => {
	it('separates work that was offered round from work that was not', () => {
		const sent = todo({ title: 'offered' });
		broadcastTask(db, sent.id, 1);
		todo({ title: 'quiet' });

		expect(listTasks(db, { broadcast: true }).map((task) => task.title)).toEqual(['offered']);
		expect(listTasks(db, { broadcast: false }).map((task) => task.title)).toEqual(['quiet']);
		expect(listTasks(db, {})).toHaveLength(2);
	});
});
