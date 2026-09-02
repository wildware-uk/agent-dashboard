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

		// "All projects" and "Tasks" are the fixed destinations; the pinned project
		// leads the list of projects under them.
		expect(names()).toEqual(['All projects', 'Tasks', 'Pinned Beta', 'Alpha']);
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

/**
 * The waiting badge (design §7).
 *
 * This is what pays for moving requests out of the always-on banner and into
 * one project's feed: a blocked agent in a project the owner is not looking at
 * is a number on the row that navigates to it.
 */
describe('agents waiting on the owner', () => {
	const badges = () =>
		[...document.querySelectorAll('nav a')].map((link) => ({
			row: link.querySelector('span')?.textContent?.trim(),
			count: link.querySelector('[data-testid="request-badge"] [aria-hidden]')?.textContent?.trim()
		}));

	it('puts the count on the project it is waiting in', async () => {
		render(Sidebar, { projects, requestCounts: { p1: 3 } });

		expect(badges()).toEqual([
			{ row: 'All projects', count: undefined },
			{ row: 'Tasks', count: undefined },
			{ row: 'Pinned', count: undefined },
			{ row: 'Alpha', count: '3' }
		]);
	});

	it('puts the total on "All projects", which is where an unfiled request lives', async () => {
		const screen = render(Sidebar, { projects, requestCounts: { p1: 1 }, totalRequests: 2 });

		const all = screen.getByRole('link', { name: /All projects/ }).element();
		expect(all.querySelector('[data-testid="request-badge"] [aria-hidden]')?.textContent).toBe('2');
	});

	it('says what the number means rather than leaving a bare digit', async () => {
		const screen = render(Sidebar, { projects, requestCounts: { p1: 3 } });

		await expect.element(screen.getByText('3 waiting on you')).toBeInTheDocument();
	});

	it('badges an archived project too, once it is revealed', async () => {
		const screen = render(Sidebar, { projects, requestCounts: { p3: 1 } });

		await screen.getByRole('button', { name: /Archived/ }).click();

		const old = screen.getByRole('link', { name: /Old/ }).element();
		expect(old.querySelector('[data-testid="request-badge"]')).not.toBeNull();
	});

	it('shows no badge at all when nothing is waiting', async () => {
		render(Sidebar, { projects, requestCounts: {}, totalRequests: 0 });

		expect(document.querySelectorAll('[data-testid="request-badge"]')).toHaveLength(0);
	});
});

/**
 * Tasks are the long-running half of the product, and until this link they
 * lived only in a rail that is `xl:block` — invisible below 1280px.
 */
describe('getting to the tasks', () => {
	it('offers a way there from every width', async () => {
		const screen = render(Sidebar, { projects });

		const link = screen.getByTestId('tasks-link').element();
		expect(link.getAttribute('href')).toBe('/tasks');
	});

	it('counts what is outstanding, not what has ever existed', async () => {
		const screen = render(Sidebar, { projects, openTasks: 4 });

		await expect.element(screen.getByTestId('open-tasks')).toHaveTextContent('4');
	});

	it('says nothing when there is nothing outstanding', async () => {
		const screen = render(Sidebar, { projects, openTasks: 0 });

		await expect.element(screen.getByTestId('open-tasks')).not.toBeInTheDocument();
	});
});

/**
 * The "new since you last looked" badge.
 *
 * A different question from the amber one, and the test that matters is that
 * they stay different: a row carrying both must show both, or "an agent is
 * blocked on you" and "three things happened" collapse into one number that
 * means neither.
 */
describe('what is new in a project', () => {
	const unseenOn = (name: string) =>
		[...document.querySelectorAll('nav a')]
			.find((link) => link.textContent?.includes(name))
			?.querySelector('[data-testid="unseen-badge"] [aria-hidden]')
			?.textContent?.trim();

	it('puts the count on the project the updates landed in', async () => {
		render(Sidebar, { projects, unseenCounts: { p1: 4 } });

		expect(unseenOn('Alpha')).toBe('4');
		expect(unseenOn('Beta')).toBeUndefined();
	});

	it('says what the number means rather than leaving a bare digit', async () => {
		const screen = render(Sidebar, { projects, unseenCounts: { p1: 4 } });

		await expect.element(screen.getByText('4 new since you last looked')).toBeInTheDocument();
	});

	it('shows both badges on a row that has earned both, and keeps them apart', async () => {
		const screen = render(Sidebar, {
			projects,
			requestCounts: { p1: 1 },
			unseenCounts: { p1: 4 }
		});

		const row = screen.getByRole('link', { name: /Alpha/ }).element();
		expect(row.querySelector('[data-testid="request-badge"] [aria-hidden]')?.textContent).toBe('1');
		expect(row.querySelector('[data-testid="unseen-badge"] [aria-hidden]')?.textContent).toBe('4');
	});

	it('badges an archived project too, once it is revealed', async () => {
		const screen = render(Sidebar, { projects, unseenCounts: { p3: 2 } });

		await screen.getByRole('button', { name: /Archived/ }).click();

		expect(unseenOn('Old')).toBe('2');
	});

	it('shows nothing for a project that is caught up', async () => {
		render(Sidebar, { projects, unseenCounts: {} });

		expect(document.querySelector('[data-testid="unseen-badge"]')).toBeNull();
	});
});
