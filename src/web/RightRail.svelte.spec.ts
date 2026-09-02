import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import RightRail from './RightRail.svelte';
import { PRESENCE_WINDOW_MS, Presence } from './presence.svelte';
import { FakeStream, aLiveAgent, fakeActions, fakeAgentsApi } from './testing';

const NOW = Date.UTC(2026, 7, 25, 10, 0, 0);

/**
 * The rail with a fake endpoint, a fake stream and a clock the test moves.
 *
 * Nothing here is a stand-in for presence itself: the store derives it exactly
 * as it does in production, so what the spec asserts is the real rule.
 */
function mount(agents = [aLiveAgent()], props: Record<string, unknown> = {}) {
	const api = fakeAgentsApi({ seq: 4, agents });
	const stream = new FakeStream();
	let now = NOW;

	const presence = new Presence({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run),
		clock: () => now,
		tickMs: 5,
		pollMs: 60_000
	});

	return {
		api,
		stream,
		presence,
		advance: (ms: number) => (now += ms),
		screen: render(RightRail, { presence, ...props })
	};
}

describe('the live agents rail', () => {
	it('says so plainly when nobody is working', async () => {
		const { api, screen } = mount([]);
		await api.settle();

		await expect.element(screen.getByText('No agents online.')).toBeInTheDocument();
	});

	it('lists an agent with the session metadata the design asks for', async () => {
		const { api, screen } = mount([
			aLiveAgent({ name: 'scout', host: 'wildware', cwd: '/srv/ssd1/app', model: 'opus' })
		]);
		await api.settle();

		await expect.element(screen.getByText('scout')).toBeInTheDocument();
		await expect.element(screen.getByText('wildware')).toBeInTheDocument();
		await expect.element(screen.getByText('/srv/ssd1/app')).toBeInTheDocument();
		await expect.element(screen.getByText('opus')).toBeInTheDocument();
	});

	it('says how long ago the last heartbeat was, because that is the live part', async () => {
		const { api, advance, screen } = mount([aLiveAgent({ lastHeartbeatAt: NOW })]);
		await api.settle();

		advance(30_000);

		await expect.element(screen.getByText('30s ago')).toBeInTheDocument();
	});

	it('shows an agent that comes online, without a reload', async () => {
		const { api, stream, screen } = mount([]);
		await api.settle();

		api.replace([aLiveAgent({ agentId: 'a2', name: 'runner' })], 5);
		stream.emit('agent.presence', {
			seq: 5,
			payload: { agentId: 'a2', sessionId: 's2', online: true }
		});
		await api.settle();

		await expect.element(screen.getByText('runner')).toBeInTheDocument();
	});

	it('drops an agent that stops beating, with no event to tell it to', async () => {
		const { api, advance, screen } = mount([aLiveAgent({ name: 'scout', lastHeartbeatAt: NOW })]);
		await api.settle();
		await expect.element(screen.getByText('scout')).toBeInTheDocument();

		advance(PRESENCE_WINDOW_MS + 1);

		await vi.waitFor(() => expect(document.body.textContent).toContain('No agents online.'));
	});

	it('counts a second run rather than listing the same agent twice', async () => {
		const { api, screen } = mount([aLiveAgent({ name: 'scout', sessions: 2 })]);
		await api.settle();

		await expect.element(screen.getByText('2 sessions')).toBeInTheDocument();
		expect(document.body.textContent?.match(/scout/g)).toHaveLength(1);
	});

	it('renders agent-reported metadata as text, never as markup', async () => {
		const { api } = mount([aLiveAgent({ host: '<img src=x onerror=alert(1)>' })]);
		await api.settle();

		expect(document.querySelector('[data-rail] img')).toBeNull();
		expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
	});

	it('renders presence and nothing else: the task panel is its own component', async () => {
		const { api, screen } = mount();
		await api.settle();

		// Tasks used to be a placeholder heading in here. They are now a real panel
		// the shell mounts beside this one (`Tasks.svelte`), because the panel
		// writes as well as reads and the rail has nothing to write with.
		const headings = screen
			.getByRole('heading')
			.elements()
			.map((node) => node.textContent?.replace(/\s+/g, ' ').trim());
		expect(headings).toEqual(['Live agents 1']);
	});

	it('opens the stream on mount and closes it on unmount', async () => {
		const { api, stream, screen } = mount();
		await api.settle();
		expect(stream.closed).toBe(false);

		screen.unmount();

		expect(stream.closed).toBe(true);
	});
});

/**
 * Renaming an agent from the rail (#feedback: "I'd like to see the actual
 * helpful names").
 *
 * The rail is where the names are read, so it is where they should be
 * editable — and the token is untouched, which is the point: a name was fixed
 * at mint time, so correcting one used to mean rewriting an MCP config.
 */
describe('naming an agent', () => {
	it('offers a rename only when there is a server behind the rail', async () => {
		const { api } = mount([aLiveAgent({ agentId: 'a1', name: 'claude-code@laptop' })]);
		await api.settle();

		expect(document.querySelector('[data-testid="rename-agent"]')).toBeNull();
	});

	it('sends the new name, and leaves the list to the stream', async () => {
		const acts = fakeActions();
		const { api, screen } = mount([aLiveAgent({ agentId: 'a1', name: 'claude-code@laptop' })], {
			actions: acts.actions
		});
		await api.settle();

		await screen.getByRole('button', { name: 'Rename claude-code@laptop' }).click();
		await screen.getByRole('textbox', { name: 'Name for claude-code@laptop' }).fill('work-laptop');
		await screen.getByRole('button', { name: 'Save' }).click();

		expect(acts.calls).toEqual([{ name: 'renameAgent', args: ['a1', 'work-laptop'] }]);
	});

	it('says what went wrong and keeps the box open', async () => {
		const acts = fakeActions();
		const { api, screen } = mount([aLiveAgent({ agentId: 'a1', name: 'one' })], {
			actions: acts.actions
		});
		await api.settle();
		acts.fail(new Error('no such agent'));

		await screen.getByRole('button', { name: 'Rename one' }).click();
		await screen.getByRole('textbox', { name: 'Name for one' }).fill('two');
		await screen.getByRole('button', { name: 'Save' }).click();

		await expect.element(screen.getByText('no such agent')).toBeInTheDocument();
		await expect.element(screen.getByRole('textbox', { name: 'Name for one' })).toBeInTheDocument();
	});
});
