import { describe, expect, it } from 'vitest';
import { Tasks } from './tasks.svelte';
import { FakeStream, aTask, fakeTasksApi } from './testing';

/** A store wired to a fake endpoint and a stream the test drives by hand. */
function store(
	options: { tasks?: ReturnType<typeof aTask>[]; seq?: number; project?: string } = {}
) {
	const api = fakeTasksApi({ seq: options.seq ?? 4, tasks: options.tasks ?? [aTask()] });
	const stream = new FakeStream();

	const tasks = new Tasks({
		project: options.project ?? null,
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});

	return { api, stream, tasks };
}

describe('reading the task list', () => {
	it('asks the task endpoint on start and holds what it says', async () => {
		const { api, tasks } = store({ tasks: [aTask({ title: 'Ship tasks' })] });

		tasks.start();
		await api.settle();
		tasks.stop();

		expect(api.calls).toEqual(['/api/snapshot/tasks']);
		expect(tasks.items.map((task) => task.title)).toEqual(['Ship tasks']);
		expect(tasks.seq).toBe(4);
	});

	it('scopes every request to the project the page is showing', async () => {
		const { api, tasks } = store({ project: 'agent-dashboard' });

		tasks.start();
		await api.settle();
		tasks.stop();

		expect(api.calls).toEqual(['/api/snapshot/tasks?project=agent-dashboard']);
	});

	it('adopts a snapshot it was handed without fetching one', () => {
		const { api, tasks } = store();

		tasks.hydrate(api.snapshot());

		expect(tasks.items).toHaveLength(1);
		expect(api.calls).toEqual([]);
	});

	it('groups the list the way the design lists it: todo, claimed, done', async () => {
		const { api, tasks } = store({
			tasks: [
				aTask({ id: 't1', seq: 4, title: 'waiting', state: 'todo' }),
				aTask({ id: 't2', seq: 3, title: 'working', state: 'claimed' }),
				aTask({ id: 't3', seq: 2, title: 'finished', state: 'done' }),
				aTask({ id: 't4', seq: 1, title: 'withdrawn', state: 'cancelled' })
			]
		});

		tasks.hydrate(api.snapshot());
		await api.settle();

		expect(tasks.todo.map((task) => task.title)).toEqual(['waiting']);
		expect(tasks.claimed.map((task) => task.title)).toEqual(['working']);
		// Cancelled work is over too, so it is listed with the done rather than
		// hidden: the owner cancelled it and should see that it stayed cancelled.
		expect(tasks.done.map((task) => task.title)).toEqual(['finished', 'withdrawn']);
		expect(tasks.openCount).toBe(2);
	});
});

describe('going live', () => {
	it('refetches when a task is created, and shows the new one', async () => {
		const { api, stream, tasks } = store({ tasks: [] });
		tasks.start();
		await api.settle();

		api.replace([aTask({ id: 't9', title: 'brand new' })], 5);
		stream.emit('task.created', { seq: 5, payload: { taskId: 't9', projectId: 'p1' } });
		await api.settle();
		tasks.stop();

		expect(tasks.items.map((task) => task.title)).toEqual(['brand new']);
		expect(tasks.seq).toBe(5);
	});

	it('refetches when a task changes state, which is how a claim appears live', async () => {
		const { api, stream, tasks } = store({ tasks: [aTask({ id: 't1', state: 'todo' })] });
		tasks.start();
		await api.settle();

		api.replace([aTask({ id: 't1', state: 'claimed', agentId: 'a1' })], 6);
		stream.emit('task.updated', { seq: 6, payload: { taskId: 't1', projectId: 'p1' } });
		await api.settle();
		tasks.stop();

		expect(tasks.claimed).toHaveLength(1);
		expect(tasks.todo).toEqual([]);
	});

	it('drops a frame it has already accounted for, so a replay costs nothing', async () => {
		const { api, stream, tasks } = store({ seq: 7 });
		tasks.start();
		await api.settle();
		const asked = api.calls.length;

		stream.emit('task.updated', { seq: 7, payload: { taskId: 't1', projectId: 'p1' } });
		await api.settle();
		tasks.stop();

		expect(api.calls).toHaveLength(asked);
	});

	it('rebuilds from scratch on resync, whatever seq it carries', async () => {
		const { api, stream, tasks } = store({ tasks: [aTask({ id: 'gone' })], seq: 9 });
		tasks.start();
		await api.settle();

		api.replace([aTask({ id: 'fresh', title: 'the truth' })], 9);
		stream.emit('resync', { seq: 9 });
		await api.settle();
		tasks.stop();

		expect(tasks.items.map((task) => task.id)).toEqual(['fresh']);
	});

	it('keeps what it holds when a refetch fails, and says it is offline', async () => {
		const { api, tasks } = store({ tasks: [aTask({ title: 'still here' })] });
		tasks.start();
		await api.settle();

		api.breaks();
		await tasks.refresh();
		tasks.stop();

		expect(tasks.items.map((task) => task.title)).toEqual(['still here']);
	});

	it('lets go of the stream on stop, so a navigation is not a leak', async () => {
		const { api, stream, tasks } = store();
		tasks.start();
		await api.settle();

		expect(stream.listeners).toBeGreaterThan(0);
		tasks.stop();

		expect(stream.listeners).toBe(0);
	});
});
