import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Shell from './Shell.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, aProject, anUpdate, fakeApi } from './testing';

/**
 * The shell as a whole. Responsive behaviour is CSS, and no stylesheet is loaded
 * here, so the layout itself is asserted by `shell.e2e.ts` at 375px in a real
 * page; what this covers is that all three regions and the drawer exist and are
 * wired to the store.
 */
function mount(project: string | null = null) {
	const api = fakeApi({ seq: 4, projects: [aProject()], items: [anUpdate({ body: 'hello' })] });
	const stream = new FakeStream();
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});
	return { api, stream, feed, screen: render(Shell, { snapshot: api.snapshot(), project, feed }) };
}

describe('the three regions', () => {
	it('renders the sidebar, the timeline and the rail', async () => {
		const { screen } = mount();

		await expect.element(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Update timeline')).toBeInTheDocument();
		expect(document.querySelector('[data-rail]')).not.toBeNull();
	});

	it('paints the server-rendered timeline rather than an empty shell', async () => {
		const { screen } = mount();

		await expect.element(screen.getByText('hello')).toBeInTheDocument();
	});

	it('opens the stream on mount and closes it on unmount', async () => {
		const { stream, screen } = mount();

		expect(stream.closed).toBe(false);
		screen.unmount();

		expect(stream.closed).toBe(true);
	});

	it('names the selected project in the header', async () => {
		const { screen } = mount('agent-dashboard');

		await expect
			.element(screen.getByRole('heading', { name: 'Agent Dashboard' }))
			.toBeInTheDocument();
	});
});

describe('the mobile drawer', () => {
	it('is closed until it is asked for', async () => {
		const { screen } = mount();

		await expect
			.element(screen.getByRole('button', { name: 'Open projects' }))
			.toHaveAttribute('aria-expanded', 'false');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('opens as a labelled panel with the project list in it', async () => {
		const { screen } = mount();

		await screen.getByRole('button', { name: 'Open projects' }).click();

		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).toBeInTheDocument();
	});

	it('closes on Escape, because that is what a drawer does', async () => {
		const { screen } = mount();
		await screen.getByRole('button', { name: 'Open projects' }).click();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
	});

	it('closes when a project in it is followed', async () => {
		const { screen } = mount();
		await screen.getByRole('button', { name: 'Open projects' }).click();

		// Two sidebars are mounted at once — the permanent one and the drawer's —
		// so this deliberately clicks the link inside the dialog.
		const link = document.querySelector('[role="dialog"] a[href="/projects/agent-dashboard"]');
		(link as HTMLElement).click();

		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
	});
});
