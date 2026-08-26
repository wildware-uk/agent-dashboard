// The app's real stylesheet, so the mobile assertions below measure what a
// phone would actually get rather than an unstyled DOM: `min-h-11` is only 44px
// if Tailwind is present.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Tasks from './Tasks.svelte';
import { Tasks as TaskStore } from './tasks.svelte';
import { FakeStream, aProject, aTask, fakeActions, fakeTasksApi } from './testing';

/**
 * The owner's task panel (design §7): a plain per-project list across todo,
 * claimed and done, with no drag and drop.
 *
 * The store is the real one, wired to a fake endpoint and a fake stream, so what
 * these specs assert about live behaviour is the production rule rather than a
 * stand-in for it.
 */
function mount(
	options: {
		tasks?: ReturnType<typeof aTask>[];
		project?: string | null;
		agentNames?: Record<string, string>;
		seq?: number;
	} = {}
) {
	const api = fakeTasksApi({ seq: options.seq ?? 4, tasks: options.tasks ?? [] });
	const stream = new FakeStream();
	const feed = new TaskStore({
		project: options.project ?? null,
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});
	const acts = fakeActions();

	return {
		api,
		stream,
		feed,
		acts,
		screen: render(Tasks, {
			tasks: feed,
			project: options.project ?? null,
			projects: [aProject(), aProject({ id: 'p2', slug: 'other', name: 'Other' })],
			agentNames: options.agentNames ?? { a1: 'scout' },
			actions: acts.actions
		})
	};
}

describe('the task list', () => {
	it('says so plainly when there is no work yet', async () => {
		const { api, screen } = mount();
		await api.settle();

		await expect.element(screen.getByText('No tasks yet.')).toBeInTheDocument();
	});

	it('groups the work across todo, claimed and done', async () => {
		const { api, screen } = mount({
			tasks: [
				aTask({ id: 't1', seq: 4, title: 'waiting' }),
				aTask({ id: 't2', seq: 3, title: 'working', state: 'claimed', agentId: 'a1' }),
				aTask({ id: 't3', seq: 2, title: 'finished', state: 'done', result: 'shipped it' })
			]
		});
		await api.settle();

		await expect.element(screen.getByRole('heading', { name: /To do/ })).toBeInTheDocument();
		await expect.element(screen.getByRole('heading', { name: /Claimed/ })).toBeInTheDocument();
		await expect.element(screen.getByRole('heading', { name: /Done/ })).toBeInTheDocument();
		await expect.element(screen.getByText('waiting')).toBeInTheDocument();
		// The claimant is shown by name — as the selected assignee, so the owner can
		// hand the work to somebody else without leaving the row.
		await expect.element(screen.getByLabelText('Assignee for working')).toHaveValue('a1');
		await expect.element(screen.getByText('shipped it')).toBeInTheDocument();
	});

	it('names the agent a task was targeted at while it is still on the queue', async () => {
		const { api, screen } = mount({
			tasks: [aTask({ agentId: 'a2', title: 'yours' })],
			agentNames: { a2: 'docs-writer' }
		});
		await api.settle();

		await expect.element(screen.getByText('docs-writer')).toBeInTheDocument();
	});

	it('moves a task from todo to claimed when the claim arrives, with no reload', async () => {
		const { api, stream, screen } = mount({
			tasks: [aTask({ id: 't1', title: 'the only task' })]
		});
		await api.settle();
		await expect.element(screen.getByText('the only task')).toBeInTheDocument();

		api.replace([aTask({ id: 't1', title: 'the only task', state: 'claimed', agentId: 'a1' })], 5);
		stream.emit('task.updated', { seq: 5, payload: { taskId: 't1', projectId: 'p1' } });
		await api.settle();

		// Same task, now under Claimed and attributed to the agent that took it.
		await expect
			.element(screen.getByRole('listitem', { name: /the only task/ }))
			.toHaveAttribute('data-state', 'claimed');
		await expect.element(screen.getByText('scout')).toBeInTheDocument();
	});
});

describe('creating a task', () => {
	it('stays out of the way until it is wanted', async () => {
		const { api, screen } = mount({ project: 'agent-dashboard' });
		await api.settle();

		expect(screen.getByLabelText('Task title').elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole('button', { name: 'New task' }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	it('creates it against the project on screen, then closes and forgets', async () => {
		const { api, acts, screen } = mount({ project: 'agent-dashboard' });
		await api.settle();

		await screen.getByRole('button', { name: 'New task' }).click();
		await screen.getByLabelText('Task title').fill('Ship tasks');
		await screen.getByLabelText('Brief').fill('todo, claimed, done');
		await screen.getByRole('button', { name: 'Create task' }).click();

		expect(acts.calls).toEqual([
			{
				name: 'createTask',
				args: [
					{
						project: 'agent-dashboard',
						title: 'Ship tasks',
						body: 'todo, claimed, done',
						agentId: null
					}
				]
			}
		]);
		expect(screen.getByLabelText('Task title').elements()).toHaveLength(0);
	});

	it('targets one agent when the owner picks one (design §7)', async () => {
		const { api, acts, screen } = mount({
			project: 'agent-dashboard',
			agentNames: { a1: 'scout', a2: 'docs-writer' }
		});
		await api.settle();

		await screen.getByRole('button', { name: 'New task' }).click();
		await screen.getByLabelText('Task title').fill('Yours');
		await screen.getByLabelText('Assign to').selectOptions('docs-writer');
		await screen.getByRole('button', { name: 'Create task' }).click();

		expect(acts.calls[0].args[0]).toMatchObject({ agentId: 'a2', title: 'Yours' });
	});

	it('asks which project when the page is showing all of them', async () => {
		const { api, acts, screen } = mount({ project: null });
		await api.settle();

		await screen.getByRole('button', { name: 'New task' }).click();
		await screen.getByLabelText('Task title').fill('Somewhere');
		await screen.getByLabelText('Project').selectOptions('Other');
		await screen.getByRole('button', { name: 'Create task' }).click();

		expect(acts.calls[0].args[0]).toMatchObject({ project: 'other' });
	});

	it('refuses to submit without a title', async () => {
		const { api, acts, screen } = mount({ project: 'agent-dashboard' });
		await api.settle();

		await screen.getByRole('button', { name: 'New task' }).click();

		await expect.element(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
		expect(acts.calls).toEqual([]);
	});

	it('keeps the form open with its text when the server refuses', async () => {
		const { api, acts, screen } = mount({ project: 'agent-dashboard' });
		acts.fail(new Error('title is required'));
		await api.settle();

		await screen.getByRole('button', { name: 'New task' }).click();
		await screen.getByLabelText('Task title').fill('Doomed');
		await screen.getByRole('button', { name: 'Create task' }).click();

		await expect.element(screen.getByText('title is required')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Task title')).toHaveValue('Doomed');
	});
});

describe('steering a task the owner already created', () => {
	it('reassigns it without touching its state', async () => {
		const { api, acts, screen } = mount({
			tasks: [aTask({ id: 't1', title: 'somebody' })],
			agentNames: { a1: 'scout' }
		});
		await api.settle();

		await screen.getByLabelText('Assignee for somebody').selectOptions('scout');

		expect(acts.calls).toEqual([{ name: 'patchTask', args: ['t1', { agentId: 'a1' }] }]);
	});

	it('cancels it, but only after a confirmation', async () => {
		const { api, acts, screen } = mount({ tasks: [aTask({ id: 't1', title: 'never mind' })] });
		await api.settle();

		await screen.getByRole('button', { name: 'Cancel task never mind' }).click();
		expect(acts.calls).toEqual([]);

		await screen.getByRole('button', { name: 'Confirm cancel' }).click();

		expect(acts.calls).toEqual([{ name: 'patchTask', args: ['t1', { state: 'cancelled' }] }]);
	});

	it('offers no cancel on work that is already over', async () => {
		const { api, screen } = mount({
			tasks: [aTask({ id: 't1', title: 'finished', state: 'done', result: 'done it' })]
		});
		await api.settle();

		expect(screen.getByRole('button', { name: 'Cancel task finished' }).elements()).toHaveLength(0);
	});

	it('says what went wrong when a steer is refused, and leaves the row alone', async () => {
		const { api, acts, screen } = mount({ tasks: [aTask({ id: 't1', title: 'stuck' })] });
		acts.fail(new Error('no such agent'));
		await api.settle();

		await screen.getByRole('button', { name: 'Cancel task stuck' }).click();
		await screen.getByRole('button', { name: 'Confirm cancel' }).click();

		await expect.element(screen.getByText('no such agent')).toBeInTheDocument();
		await expect.element(screen.getByText('stuck')).toBeInTheDocument();
	});
});

describe('on a phone', () => {
	it('fits 360px without the panel scrolling sideways, and keeps 44px targets', async () => {
		const { api, screen } = mount({
			project: 'agent-dashboard',
			tasks: [
				aTask({
					id: 't1',
					title: 'a title long enough to wrap several times over on a narrow screen',
					body: 'and-a-brief-with-an-unbreakable-token-'.repeat(4)
				})
			]
		});
		await api.settle();
		const panel = screen.getByTestId('tasks-panel').element() as HTMLElement;
		panel.style.width = '360px';

		expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);

		// The controls a thumb has to hit are big enough for one (design §7).
		await screen.getByRole('button', { name: 'New task' }).click();
		for (const name of [
			'Create task',
			'Cancel task ' + 'a title long enough to wrap several times over on a narrow screen'
		]) {
			const button = screen.getByRole('button', { name }).element() as HTMLElement;
			// Rounded: 2.75rem lands a few ten-thousandths under 44 in a real layout.
			expect(Math.round(button.getBoundingClientRect().height), name).toBeGreaterThanOrEqual(44);
		}
	});
});
