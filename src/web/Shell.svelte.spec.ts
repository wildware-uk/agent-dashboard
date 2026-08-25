import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Shell from './Shell.svelte';
import { Presence } from './presence.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, aLiveAgent, aProject, anUpdate, fakeAgentsApi, fakeApi } from './testing';

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

/**
 * A ULID, as the server actually mints agent ids. The literal matters: every one
 * of them begins `01` until September 2039, which is why a card that shows an id
 * says nothing about who posted it (#20).
 */
const AGENT_ULID = '01M0X5XHT67FCP294SSA3B2XHV';

/**
 * The shell with both of its stores faked: the timeline snapshot that carries
 * the agent names, and the presence endpoint that keeps them live.
 */
function mountWithAgents(options: {
	agentNames?: Record<string, string>;
	agents?: ReturnType<typeof aLiveAgent>[];
}) {
	const api = fakeApi({
		seq: 4,
		projects: [aProject()],
		items: [anUpdate({ agentId: AGENT_ULID, body: 'shipped it' })],
		agentNames: options.agentNames ?? {}
	});
	const agentsApi = fakeAgentsApi({ seq: 4, agents: options.agents ?? [] });
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => new FakeStream(),
		schedule: (run) => api.queue.push(run)
	});
	const presence = new Presence({
		fetch: agentsApi.fetch,
		openStream: () => new FakeStream(),
		schedule: (run) => agentsApi.queue.push(run)
	});

	return {
		agentsApi,
		card: () => document.querySelector('article')?.textContent ?? '',
		screen: render(Shell, { snapshot: api.snapshot(), feed, presence })
	};
}

describe('attributing the cards', () => {
	it('names the poster from the snapshot, for an agent that is nowhere near online', async () => {
		// Nobody is beating, so presence knows nothing — and this is the common
		// case, because a timeline is mostly the work of agents that have gone.
		const { card } = mountWithAgents({ agentNames: { [AGENT_ULID]: 'docs-writer' } });

		await expect.poll(card).toContain('docs-writer');
		expect(card()).not.toContain(AGENT_ULID);
	});

	it('names an agent that registered a session after the page was rendered', async () => {
		const { card, agentsApi } = mountWithAgents({
			agents: [aLiveAgent({ agentId: AGENT_ULID, name: 'build-bot', lastHeartbeatAt: Date.now() })]
		});

		// Before presence answers there is no name to be had, and the card says
		// something readable rather than 26 characters.
		expect(card()).toContain('agent-3b2xhv');

		await agentsApi.settle();

		// No reload, no second snapshot: the rail's read is what named it.
		await expect.poll(card).toContain('build-bot');
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
