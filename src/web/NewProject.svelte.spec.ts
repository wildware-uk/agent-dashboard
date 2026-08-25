import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import NewProject from './NewProject.svelte';
import { fakeActions } from './testing';

/**
 * Creating a project from the browser (design §7). Agents can do it over MCP;
 * this is the owner doing it first, before any agent has connected.
 */
describe('the create form', () => {
	it('stays out of the way until it is wanted', async () => {
		const api = fakeActions();
		const screen = render(NewProject, { actions: api.actions });

		expect(screen.getByLabelText('Project name').elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole('button', { name: 'New project' }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	it('creates the project, then closes and forgets what was typed', async () => {
		const api = fakeActions();
		const screen = render(NewProject, { actions: api.actions });

		await screen.getByRole('button', { name: 'New project' }).click();
		await screen.getByLabelText('Project name').fill('Brand New');
		await screen.getByLabelText('Description').fill('a fresh one');
		await screen.getByRole('button', { name: 'Create project' }).click();

		expect(api.calls).toEqual([
			{ name: 'createProject', args: [{ name: 'Brand New', description: 'a fresh one' }] }
		]);
		expect(screen.getByLabelText('Project name').elements()).toHaveLength(0);
	});

	it('sends no description when none was written', async () => {
		const api = fakeActions();
		const screen = render(NewProject, { actions: api.actions });

		await screen.getByRole('button', { name: 'New project' }).click();
		await screen.getByLabelText('Project name').fill('Bare');
		await screen.getByRole('button', { name: 'Create project' }).click();

		expect(api.calls[0].args[0]).toEqual({ name: 'Bare', description: null });
	});

	it('refuses to submit a blank name', async () => {
		const api = fakeActions();
		const screen = render(NewProject, { actions: api.actions });

		await screen.getByRole('button', { name: 'New project' }).click();

		await expect.element(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
		expect(api.calls).toEqual([]);
	});

	it('keeps the form open with its text when the server refuses', async () => {
		const api = fakeActions();
		api.fail(new Error('name is required'));
		const screen = render(NewProject, { actions: api.actions });

		await screen.getByRole('button', { name: 'New project' }).click();
		await screen.getByLabelText('Project name').fill('Doomed');
		await screen.getByRole('button', { name: 'Create project' }).click();

		await expect.element(screen.getByText('name is required')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Project name')).toHaveValue('Doomed');
	});
});
