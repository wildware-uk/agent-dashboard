import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import RightRail from './RightRail.svelte';
import { PRESENCE_WINDOW_MS, Presence } from './presence.svelte';
import { FakeStream, aLiveAgent, fakeAgentsApi } from './testing';

const NOW = Date.UTC(2026, 7, 25, 10, 0, 0);

/**
 * The rail with a fake endpoint, a fake stream and a clock the test moves.
 *
 * Nothing here is a stand-in for presence itself: the store derives it exactly
 * as it does in production, so what the spec asserts is the real rule.
 */
function mount(agents = [aLiveAgent()]) {
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
		screen: render(RightRail, { presence })
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

	it('leaves the tasks slot alone for the control-plane slice', async () => {
		const { api, screen } = mount();
		await api.settle();

		await expect.element(screen.getByText('Open tasks')).toBeInTheDocument();
	});

	it('opens the stream on mount and closes it on unmount', async () => {
		const { api, stream, screen } = mount();
		await api.settle();
		expect(stream.closed).toBe(false);

		screen.unmount();

		expect(stream.closed).toBe(true);
	});
});
