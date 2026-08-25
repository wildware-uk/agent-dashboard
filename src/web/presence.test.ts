import { describe, expect, it, vi } from 'vitest';
import { PRESENCE_WINDOW_MS, Presence } from './presence.svelte';
import { FakeStream, aLiveAgent, fakeAgentsApi } from './testing';

const NOW = Date.UTC(2026, 7, 25, 10, 0, 0);

/**
 * A store wired to a fake endpoint, a fake stream and a clock the test moves.
 *
 * `tickMs` is tiny so the derived clock is observable inside a test without fake
 * timers, which the store's own `fetch` doubles would not survive.
 */
function store(
	options: { agents?: ReturnType<typeof aLiveAgent>[]; seq?: number; pollMs?: number } = {}
) {
	const api = fakeAgentsApi({ seq: options.seq ?? 4, agents: options.agents ?? [aLiveAgent()] });
	const stream = new FakeStream();
	let now = NOW;

	const presence = new Presence({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run),
		clock: () => now,
		tickMs: 5,
		pollMs: options.pollMs ?? 60_000
	});

	return {
		api,
		stream,
		presence,
		/** Move the world forward. Nothing else happens: presence is derived. */
		advance(ms: number) {
			now += ms;
		}
	};
}

describe('reading who is online', () => {
	it('asks the presence endpoint on start and holds what it says', async () => {
		const { api, presence } = store({ agents: [aLiveAgent({ name: 'scout', host: 'wildware' })] });

		presence.start();
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual(['/api/snapshot/agents']);
		expect(presence.online).toMatchObject([{ name: 'scout', host: 'wildware' }]);
		expect(presence.seq).toBe(4);
	});

	it('adopts a snapshot it was handed without fetching one', async () => {
		const { api, presence } = store();

		presence.hydrate(api.snapshot());

		expect(presence.agents).toHaveLength(1);
		expect(api.calls).toEqual([]);
	});

	it('replaces the whole list rather than merging: presence is the whole answer', async () => {
		const { api, presence } = store({ agents: [aLiveAgent({ agentId: 'a1', name: 'scout' })] });
		presence.start();
		await api.settle();

		api.replace([aLiveAgent({ agentId: 'a2', name: 'runner' })]);
		await presence.refresh();
		presence.stop();

		expect(presence.online.map((agent) => agent.name)).toEqual(['runner']);
	});
});

describe('presence is derived in the browser too', () => {
	it('drops an agent whose heartbeat aged out, with no event and no refetch', async () => {
		const { api, presence, advance } = store({
			agents: [aLiveAgent({ lastHeartbeatAt: NOW })]
		});
		presence.start();
		await api.settle();
		expect(presence.online).toHaveLength(1);

		// Nothing arrives: going quiet is the absence of an event (design §4).
		advance(PRESENCE_WINDOW_MS + 1);
		await vi.waitFor(() => expect(presence.online).toHaveLength(0));

		// Still held, still not shown: the row is data, `online` is the derivation.
		expect(presence.agents).toHaveLength(1);
		expect(api.calls).toEqual(['/api/snapshot/agents']);
		presence.stop();
	});

	it('keeps an agent whose last heartbeat is exactly on the window', async () => {
		const { api, presence, advance } = store({ agents: [aLiveAgent({ lastHeartbeatAt: NOW })] });
		presence.start();
		await api.settle();

		advance(PRESENCE_WINDOW_MS);
		await vi.waitFor(() => expect(presence.now).toBe(NOW + PRESENCE_WINDOW_MS));

		expect(presence.online).toHaveLength(1);
		presence.stop();
	});

	it('stops deriving once it is stopped, so a hidden rail costs nothing', async () => {
		const { api, presence, advance } = store();
		presence.start();
		await api.settle();
		presence.stop();

		advance(PRESENCE_WINDOW_MS + 1);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(presence.now).toBe(NOW);
	});
});

describe('the stream', () => {
	it('refetches once for a burst of presence events', async () => {
		const { api, presence, stream } = store();
		presence.start();
		await api.settle();
		api.calls.length = 0;

		stream.emit('agent.presence', {
			seq: 5,
			payload: { agentId: 'a1', sessionId: 's1', online: true }
		});
		stream.emit('agent.presence', {
			seq: 6,
			payload: { agentId: 'a2', sessionId: 's2', online: true }
		});
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual(['/api/snapshot/agents']);
	});

	it('ignores a frame the snapshot already accounts for, so replay costs nothing', async () => {
		const { api, presence, stream } = store({ seq: 10 });
		presence.start();
		await api.settle();
		api.calls.length = 0;

		stream.emit('agent.presence', {
			seq: 9,
			payload: { agentId: 'a1', sessionId: 's1', online: true }
		});
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual([]);
	});

	it('rebuilds on resync, whatever seq it carries', async () => {
		const { api, presence, stream } = store({ seq: 10 });
		presence.start();
		await api.settle();
		api.calls.length = 0;

		stream.emit('resync', { seq: 2 });
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual(['/api/snapshot/agents']);
	});

	it('resumes from the seq it holds, so it is not replayed the whole buffer', async () => {
		const { api, presence } = store({ seq: 41 });
		presence.hydrate(api.snapshot());

		presence.start();
		await api.settle();
		presence.stop();

		expect(presence.seq).toBe(41);
	});

	it('drops a malformed frame instead of throwing', async () => {
		const api = fakeAgentsApi({ agents: [aLiveAgent()] });
		let deliver: ((event: MessageEvent) => void) | null = null;
		const presence = new Presence({
			fetch: api.fetch,
			openStream: () => ({
				addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
					if (type === 'agent.presence') deliver = listener;
				},
				removeEventListener: () => {},
				close: () => {}
			}),
			schedule: (run) => api.queue.push(run),
			clock: () => NOW
		});
		presence.start();
		await api.settle();
		api.calls.length = 0;

		// What a garbled proxy or a half-written frame delivers.
		(deliver as unknown as (event: MessageEvent) => void)({ data: 'not json' } as MessageEvent);
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual([]);
	});

	it('is idempotent on start, so nothing can end up with two clocks', async () => {
		const { api, presence } = store();

		presence.start();
		presence.start();
		await api.settle();
		presence.stop();

		expect(api.calls).toEqual(['/api/snapshot/agents']);
	});

	it('drops a refetch queued the moment before it stopped', async () => {
		const { api, presence, stream } = store();
		presence.start();
		await api.settle();
		api.calls.length = 0;

		stream.emit('agent.presence', {
			seq: 5,
			payload: { agentId: 'a1', sessionId: 's1', online: true }
		});
		// Unmounted between the event and the coalesced read it asked for.
		presence.stop();
		await api.settle();

		expect(api.calls).toEqual([]);
	});

	it('closes the connection when it stops', async () => {
		const { api, presence, stream } = store();
		presence.start();
		await api.settle();

		presence.stop();

		expect(stream.closed).toBe(true);
		expect(presence.status).toBe('idle');
	});

	it('still reads presence when the stream cannot be opened at all', async () => {
		const api = fakeAgentsApi({ agents: [aLiveAgent()] });
		const presence = new Presence({
			fetch: api.fetch,
			openStream: () => {
				throw new Error('EventSource is not available');
			},
			schedule: (run) => api.queue.push(run),
			clock: () => NOW
		});

		presence.start();
		await api.settle();

		expect(presence.status).toBe('offline');
		expect(presence.online).toHaveLength(1);
		presence.stop();
	});
});

describe('the poll that keeps heartbeat times fresh', () => {
	it('re-reads on its interval with no events at all', async () => {
		const { api, presence } = store({ pollMs: 5 });
		presence.start();
		await api.settle();

		await vi.waitFor(async () => {
			await api.settle();
			expect(api.calls.length).toBeGreaterThan(1);
		});
		presence.stop();

		const calls = api.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		await api.settle();
		// Stopped means stopped: no timer left polling a rail nobody is looking at.
		expect(api.calls.length).toBe(calls);
	});
});

describe('when the server is unreachable', () => {
	it('keeps the rows it has and says it is offline', async () => {
		const { api, presence } = store();
		presence.start();
		await api.settle();

		api.breaks(500);
		await presence.refresh();

		expect(presence.status).toBe('offline');
		expect(presence.online).toHaveLength(1);
		presence.stop();
	});

	it('never has two reads out at once', async () => {
		const { api, presence } = store();

		await Promise.all([presence.refresh(), presence.refresh(), presence.refresh()]);

		expect(api.calls).toHaveLength(1);
	});
});
