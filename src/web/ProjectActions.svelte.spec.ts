import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import ProjectActions from './ProjectActions.svelte';
import { aMedia, aProject, fakeActions } from './testing';

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

/**
 * Per-project styling (design §7). Two colours, because everything else is
 * derived — see `theme.ts` for why asking for more is how themes break.
 */
describe('styling a project', () => {
	const openMenu = async (project = aProject()) => {
		const api = fakeActions();
		const screen = render(ProjectActions, { project, actions: api.actions });
		await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
		return { api, screen };
	};

	it('offers colours on a project that has none', async () => {
		const { screen } = await openMenu();

		await expect.element(screen.getByTestId('style-project')).toHaveTextContent('Set colours');
	});

	it('says so differently once a project has some', async () => {
		const { screen } = await openMenu(aProject({ theme: { accent: '#ffb300' } }));

		await expect.element(screen.getByTestId('style-project')).toHaveTextContent('Change colours');
	});

	it('sends both colours together', async () => {
		const { api, screen } = await openMenu();

		await screen.getByTestId('style-project').click();
		await screen.getByRole('button', { name: 'Save' }).click();

		expect(api.calls).toEqual([
			{
				name: 'patchProject',
				args: ['agent-dashboard', { theme: { background: '#111419', accent: '#5aa2f5' } }]
			}
		]);
	});

	it('starts the pickers at the project’s own colours, not at black', async () => {
		const { screen } = await openMenu(
			aProject({ theme: { background: '#101820', accent: '#ffb300' } })
		);

		await screen.getByTestId('style-project').click();

		await expect
			.element(screen.getByRole('textbox', { name: 'Background colour' }))
			.toHaveValue('#101820');
	});

	it('offers no reset on a project with nothing to reset', async () => {
		const { screen } = await openMenu();

		await screen.getByTestId('style-project').click();

		await expect.element(screen.getByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
	});

	it('resets a themed project back to the dashboard’s own styling', async () => {
		const { api, screen } = await openMenu(aProject({ theme: { accent: '#ffb300' } }));

		await screen.getByTestId('style-project').click();
		await screen.getByRole('button', { name: 'Reset' }).click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { theme: null }] }
		]);
	});

	it('says how to get a logo when the project has no images yet', async () => {
		const { screen } = await openMenu();

		await screen.getByTestId('style-project').click();

		await expect.element(screen.getByTestId('no-logo-choices')).toBeInTheDocument();
		await expect.element(screen.getByText(/set_project_theme/)).toBeInTheDocument();
	});

	it('offers the project’s own images as logos', async () => {
		const api = fakeActions();
		const screen = render(ProjectActions, {
			project: aProject(),
			images: [aMedia({ id: 'm1' }), aMedia({ id: 'm2' })],
			actions: api.actions
		});
		await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
		await screen.getByTestId('style-project').click();

		await expect.element(screen.getByTestId('logo-choices')).toBeInTheDocument();
		await screen.getByRole('button', { name: 'Use this image as the logo' }).first().click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { theme: { logoMediaId: 'm1' } }] }
		]);
	});

	it('sets a logo without disturbing the colours already set', async () => {
		// The server merges a theme field by field, so the patch names only the
		// logo — an accent already on the project survives it.
		const api = fakeActions();
		const screen = render(ProjectActions, {
			project: aProject({ theme: { accent: '#ffb300' } }),
			images: [aMedia({ id: 'm1' })],
			actions: api.actions
		});
		await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
		await screen.getByTestId('style-project').click();
		await screen.getByRole('button', { name: 'Use this image as the logo' }).click();

		expect(api.calls[0].args[1]).toEqual({ theme: { logoMediaId: 'm1' } });
	});

	it('removes a logo the project already has', async () => {
		const api = fakeActions();
		const screen = render(ProjectActions, {
			project: aProject({ theme: { logoMediaId: 'm1' } }),
			images: [aMedia({ id: 'm1' })],
			actions: api.actions
		});
		await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
		await screen.getByTestId('style-project').click();
		await screen.getByRole('button', { name: 'Remove logo' }).click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { theme: { logoMediaId: null } }] }
		]);
	});

	it('offers the wordmark switch only once there is a logo', async () => {
		const api = fakeActions();
		const screen = render(ProjectActions, {
			project: aProject({ theme: { logoMediaId: 'm1' } }),
			images: [aMedia({ id: 'm1' })],
			actions: api.actions
		});
		await screen.getByRole('button', { name: /Manage Agent Dashboard/ }).click();
		await screen.getByTestId('style-project').click();

		await screen.getByRole('checkbox', { name: /instead of the name/ }).click();

		expect(api.calls).toEqual([
			{ name: 'patchProject', args: ['agent-dashboard', { theme: { logoReplacesName: true } }] }
		]);
	});

	it('offers no wordmark switch on a project with no logo', async () => {
		const { screen } = await openMenu();

		await screen.getByTestId('style-project').click();

		await expect
			.element(screen.getByRole('checkbox', { name: /instead of the name/ }))
			.not.toBeInTheDocument();
	});

	it('offers no remove button when there is no logo', async () => {
		const { screen } = await openMenu();

		await screen.getByTestId('style-project').click();

		await expect
			.element(screen.getByRole('button', { name: 'Remove logo' }))
			.not.toBeInTheDocument();
	});
});
