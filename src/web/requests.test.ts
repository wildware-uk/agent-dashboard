import { describe, expect, it, vi } from 'vitest';
import { REQUEST_KINDS } from '$domain';
import { Requests } from './requests.svelte';
import { EVENT_TYPES } from './stream';
import { FakeStream, aRequest, fakeRequestsApi } from './testing';
import type { RequestKind, RequestView } from './types';

/** A store wired to a fake endpoint and a stream the test drives by hand. */
function store(options: { requests?: RequestView[]; seq?: number } = {}) {
	const api = fakeRequestsApi({
		seq: options.seq ?? 4,
		requests: options.requests ?? [aRequest()]
	});
	const stream = new FakeStream();

	const requests = new Requests({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run),
		notify: null
	});

	return { api, stream, requests };
}

describe('reading what is waiting on the owner', () => {
	it('asks the request endpoint on start and holds what it says', async () => {
		const { api, requests } = store({ requests: [aRequest({ question: 'Push to main?' })] });

		requests.start();
		await api.settle();
		requests.stop();

		expect(api.calls).toEqual(['/api/snapshot/requests']);
		expect(requests.items.map((request) => request.question)).toEqual(['Push to main?']);
		expect(requests.seq).toBe(4);
	});

	it('is never scoped to a project: a blocked agent must not hide behind a sidebar click', async () => {
		const { api, requests } = store();

		requests.start();
		await api.settle();
		requests.stop();

		expect(api.calls.every((url) => !url.includes('project'))).toBe(true);
	});

	it('adopts a snapshot it was handed without fetching one', () => {
		const { api, requests } = store();

		requests.hydrate(api.snapshot());

		expect(requests.count).toBe(1);
		expect(api.calls).toEqual([]);
	});
});

describe('staying live (design §4)', () => {
	it('refetches when an agent asks for something', async () => {
		const { api, stream, requests } = store({ requests: [] });
		requests.start();
		await api.settle();

		api.replace([aRequest({ id: 'r2', question: 'Which branch?' })], 5);
		stream.emit('request.created', { seq: 5, payload: { requestId: 'r2', kind: 'choice' } });
		await api.settle();

		expect(requests.items.map((request) => request.id)).toEqual(['r2']);
		requests.stop();
	});

	it('refetches when one is settled, so an answered prompt leaves the banner', async () => {
		const { api, stream, requests } = store();
		requests.start();
		await api.settle();

		api.replace([], 6);
		stream.emit('request.answered', { seq: 6, payload: { requestId: 'r1', state: 'answered' } });
		await api.settle();

		expect(requests.items).toEqual([]);
		requests.stop();
	});

	it('coalesces a burst of events into one refetch', async () => {
		const { api, stream, requests } = store();
		requests.start();
		await api.settle();
		const before = api.calls.length;

		for (let seq = 5; seq < 9; seq += 1) {
			stream.emit('request.created', { seq, payload: { requestId: `r${seq}`, kind: 'confirm' } });
		}
		await api.settle();

		expect(api.calls.length).toBe(before + 1);
		requests.stop();
	});

	it('ignores a frame it has already accounted for', async () => {
		const { api, stream, requests } = store({ seq: 9 });
		requests.start();
		await api.settle();
		const before = api.calls.length;

		stream.emit('request.answered', { seq: 3, payload: { requestId: 'r1' } });
		await api.settle();

		expect(api.calls.length).toBe(before);
		requests.stop();
	});

	it('always refetches on resync, whatever the seq says', async () => {
		const { api, stream, requests } = store({ seq: 9 });
		requests.start();
		await api.settle();
		const before = api.calls.length;

		stream.emit('resync', { seq: 1 });
		await api.settle();

		expect(api.calls.length).toBe(before + 1);
		requests.stop();
	});

	it('keeps what it holds when the endpoint fails, rather than emptying the banner', async () => {
		const { api, stream, requests } = store();
		requests.start();
		await api.settle();

		api.breaks(500);
		stream.emit('request.created', { seq: 7, payload: { requestId: 'r2', kind: 'confirm' } });
		await api.settle();

		expect(requests.count).toBe(1);
		expect(requests.status).toBe('offline');
		requests.stop();
	});

	it('releases the stream on stop, and only when the last holder lets go', async () => {
		const { api, stream, requests } = store();

		requests.start();
		requests.start();
		await api.settle();
		requests.stop();
		expect(stream.closed).toBe(false);

		requests.stop();
		expect(stream.closed).toBe(true);
		expect(stream.listeners).toBe(0);
	});

	it('watches the event types the transport actually carries', () => {
		for (const type of ['request.created', 'request.answered', 'resync']) {
			expect(EVENT_TYPES, type).toContain(type);
		}
	});
});

describe('the optional browser notification (design §7)', () => {
	it('fires once when an agent asks, and not when one is answered', async () => {
		const notify = vi.fn();
		const api = fakeRequestsApi({ seq: 1, requests: [] });
		const stream = new FakeStream();
		const requests = new Requests({
			fetch: api.fetch,
			openStream: () => stream,
			schedule: (run) => api.queue.push(run),
			notify
		});
		requests.start();
		await api.settle();

		stream.emit('request.created', { seq: 2, payload: { requestId: 'r2', kind: 'confirm' } });
		stream.emit('request.answered', { seq: 3, payload: { requestId: 'r2' } });
		await api.settle();

		expect(notify).toHaveBeenCalledTimes(1);
		requests.stop();
	});

	it('survives a notifier that throws: a courtesy must not take the banner down', async () => {
		const api = fakeRequestsApi({ seq: 1, requests: [] });
		const stream = new FakeStream();
		const requests = new Requests({
			fetch: api.fetch,
			openStream: () => stream,
			schedule: (run) => api.queue.push(run),
			notify: () => {
				throw new Error('permission denied');
			}
		});
		requests.start();
		await api.settle();

		api.replace([aRequest({ id: 'r2' })], 2);
		stream.emit('request.created', { seq: 2, payload: { requestId: 'r2', kind: 'confirm' } });
		await api.settle();

		expect(requests.items.map((request) => request.id)).toEqual(['r2']);
		requests.stop();
	});
});

describe('the wire format the banner reads', () => {
	/**
	 * `src/web/` may not import `$domain` — it ships to the browser — so the kinds
	 * are re-declared in `./types.ts`. This is the pin that stops that copy
	 * rotting: a test file is not shipped, so it may read the server's own list,
	 * and a kind added or renamed there fails here rather than in a browser.
	 */
	it('names exactly the kinds the server offers', () => {
		const mine: RequestKind[] = ['text', 'confirm', 'buttons', 'choice', 'multi_choice'];

		expect([...mine].sort()).toEqual([...REQUEST_KINDS].sort());
	});
});
