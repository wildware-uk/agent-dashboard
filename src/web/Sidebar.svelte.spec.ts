import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Sidebar from './Sidebar.svelte';
import { aProject, fakeActions } from './testing';

const projects = [
	aProject({ id: 'p1', slug: 'alpha', name: 'Alpha' }),
	aProject({ id: 'p2', slug: 'beta', name: 'Beta', pinned: true }),
	aProject({ id: 'p3', slug: 'old', name: 'Old', status: 'archived' })
];

const names = () => [...document.querySelectorAll('nav a')].map((link) => link.textContent?.trim());

describe('the project sidebar', () => {
	it('puts pinned projects first, whatever order it was handed', async () => {
		render(Sidebar, { projects });

		// "All projects" is the first link; the pinned project leads the list.
		expect(names()).toEqual(['All projects', 'Pinned Beta', 'Alpha']);
	});

	it('hides archived projects behind a toggle', async () => {
		const screen = render(Sidebar, { projects });

		await expect
			.element(screen.getByRole('button', { name: /Archived \(1\)/ }))
			.toBeInTheDocument();
		expect(names()).not.toContain('Old');
	});

	it('reveals them when the toggle is used, and says so to a screen reader', async () => {
		const screen = render(Sidebar, { projects });
		const toggle = screen.getByRole('button', { name: /Archived/ });

		await toggle.click();

		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(names()).toContain('Old');
	});

	it('offers no toggle when nothing is archived', async () => {
		const screen = render(Sidebar, { projects: [projects[0]] });

		expect(screen.getByRole('button').elements()).toHaveLength(0);
	});

	it('marks the selected project as the current page', async () => {
		render(Sidebar, { projects, activeSlug: 'alpha' });

		const current = document.querySelector('a[aria-current="page"]');
		expect(current?.textContent?.trim()).toBe('Alpha');
		expect(current?.getAttribute('href')).toBe('/projects/alpha');
	});

	it('treats the whole timeline as current when no project is selected', async () => {
		render(Sidebar, { projects, activeSlug: null });

		expect(document.querySelector('a[aria-current="page"]')?.textContent?.trim()).toBe(
			'All projects'
		);
	});

	it('says so plainly when there are no projects at all', async () => {
		const screen = render(Sidebar, { projects: [] });

		await expect.element(screen.getByText('No projects yet.')).toBeInTheDocument();
	});

	it('tells the drawer to close when a project is followed', async () => {
		let closed = 0;
		const screen = render(Sidebar, { projects, onnavigate: () => (closed += 1) });

		await screen.getByRole('link', { name: /Alpha/ }).click();

		expect(closed).toBe(1);
	});
});

/**
 * The owner controls are opt-in: a sidebar handed no action client is a
 * read-only sidebar, which is what keeps it renderable — and testable — with
 * nothing behind it. Production hands it one (`Shell.svelte`).
 */
describe('the owner controls in the sidebar', () => {
	it('offers none of them until it is handed an action client', async () => {
		const screen = render(Sidebar, { projects: [projects[0]] });

		expect(screen.getByRole('button', { name: 'New project' }).elements()).toHaveLength(0);
		expect(screen.getByRole('button', { name: /Manage/ }).elements()).toHaveLength(0);
	});

	it('offers a create form and a manage menu per project when it is', async () => {
		const api = fakeActions();
		const screen = render(Sidebar, { projects, actions: api.actions });

		await expect.element(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Manage/ }).elements()).toHaveLength(2);
	});

	it('reaches an archived project’s menu too, so it can be unarchived', async () => {
		const api = fakeActions();
		const screen = render(Sidebar, { projects, actions: api.actions });

		await screen.getByRole('button', { name: /Archived/ }).click();
		await screen.getByRole('button', { name: 'Manage Old' }).click();
		await screen.getByRole('button', { name: 'Unarchive project' }).click();

		expect(api.calls).toEqual([{ name: 'patchProject', args: ['old', { status: 'active' }] }]);
	});
});
