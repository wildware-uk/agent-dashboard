import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import ProjectActions from './ProjectActions.svelte';
import { aProject, fakeActions } from './testing';

/**
 * The per-project menu in the sidebar (design §7): rename, edit description,
 * pin, archive and unarchive. Every control here is one `PATCH`, so the
 * assertions are about what it asks for rather than what it then renders — the
 * row itself comes back over the stream.
 */
const project = aProject({ slug: 'agent-dashboard', name: 'Agent Dashboard' });

async function openMenu(overrides = {}) {
	const api = fakeActions();
	const screen = render(ProjectActions, { project, actions: api.actions, ...overrides });
	await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
	return { api, screen };
}

describe('the menu', () => {
	it('stays shut until it is asked for', async () => {
		const api = fakeActions();
		const screen = render(ProjectActions, { project, actions: api.actions });

		expect(screen.getByRole('button', { name: 'Pin project' }).elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole('button', { name: /Manage Agent Dashboard/ }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	it('closes again on Escape', async () => {
		const { screen } = await openMenu();

		await expect.element(screen.getByRole('button', { name: 'Pin project' })).toBeInTheDocument();
		await screen
			.getByRole('button', { name: 'Pin project' })
			.element()
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(screen.getByRole('button', { name: 'Pin project' }).elements()).toHaveLength(0);
	});
});

describe('pinning', () => {
	it('pins an unpinned project', async () => {
		const { api, screen } = await openMenu();

		await screen.getByRole('button', { name: 'Pin project' }).click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { pinned: true }] }
		]);
	});

	it('unpins a pinned one', async () => {
		const { api, screen } = await openMenu({ project: aProject({ pinned: true }) });

		await screen.getByRole('button', { name: 'Unpin project' }).click();

		expect(api.calls[0].args[1]).toEqual({ pinned: false });
	});
});

describe('archiving', () => {
	it('archives an active project', async () => {
		const { api, screen } = await openMenu();

		await screen.getByRole('button', { name: 'Archive project' }).click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { status: 'archived' }] }
		]);
	});

	it('restores an archived one', async () => {
		const { api, screen } = await openMenu({ project: aProject({ status: 'archived' }) });

		await screen.getByRole('button', { name: 'Unarchive project' }).click();

		expect(api.calls[0].args[1]).toEqual({ status: 'active' });
	});
});

describe('renaming and describing', () => {
	it('opens a form with what the project says today', async () => {
		const { screen } = await openMenu({
			project: aProject({ name: 'Agent Dashboard', description: 'watch the agents' })
		});

		await screen.getByRole('button', { name: 'Rename project' }).click();

		await expect.element(screen.getByLabelText('Project name')).toHaveValue('Agent Dashboard');
		await expect.element(screen.getByLabelText('Description')).toHaveValue('watch the agents');
	});

	it('sends the new name and description together', async () => {
		const { api, screen } = await openMenu();

		await screen.getByRole('button', { name: 'Rename project' }).click();
		await screen.getByLabelText('Project name').fill('Dashboard');
		await screen.getByLabelText('Description').fill('the one');
		await screen.getByRole('button', { name: 'Save' }).click();

		expect(api.calls).toEqual([
			{
				name: 'patchProject',
				args: ['agent-dashboard', { name: 'Dashboard', description: 'the one' }]
			}
		]);
	});

	it('clears a description to null rather than to an empty string', async () => {
		const { api, screen } = await openMenu({ project: aProject({ description: 'watch them' }) });

		await screen.getByRole('button', { name: 'Rename project' }).click();
		await screen.getByLabelText('Description').fill('');
		await screen.getByRole('button', { name: 'Save' }).click();

		expect(api.calls[0].args[1]).toEqual({ name: 'Agent Dashboard', description: null });
	});

	it('will not send a blank name', async () => {
		const { api, screen } = await openMenu();

		await screen.getByRole('button', { name: 'Rename project' }).click();
		await screen.getByLabelText('Project name').fill('   ');

		await expect.element(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		expect(api.calls).toEqual([]);
	});

	it('keeps the form and what was typed when the server refuses', async () => {
		const { api, screen } = await openMenu();
		api.fail(new Error('slug already in use: other'));

		await screen.getByRole('button', { name: 'Rename project' }).click();
		await screen.getByLabelText('Project name').fill('Other');
		await screen.getByRole('button', { name: 'Save' }).click();

		await expect.element(screen.getByText(/slug already in use/)).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Project name')).toHaveValue('Other');
	});
});
