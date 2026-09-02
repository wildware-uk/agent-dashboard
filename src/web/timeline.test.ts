import { beforeEach, describe, expect, it } from 'vitest';
import { Timeline, type TimelineOptions } from './timeline.svelte';
import { FakeStream, aMedia, aProject, anUpdate, fakeApi } from './testing';

/**
 * The client store, driven the way the server drives it: a snapshot, then
 * events. No DOM here — the store owns state and requests, and the components
 * that render it are covered by the `.svelte.spec.ts` files.
 */

const first = anUpdate({ id: 'u1', seq: 10, body: 'first' });
const second = anUpdate({ id: 'u2', seq: 11, body: 'second' });
const third = anUpdate({ id: 'u3', seq: 12, body: 'third' });

let api: ReturnType<typeof fakeApi>;
let stream: FakeStream;

function timeline(options: Partial<TimelineOptions> = {}) {
	stream = new FakeStream();
	return new Timeline({
		fetch: api.fetch,
		openStream: (url) => {
			stream.url = url;
			return stream;
		},
		// Refreshes are coalesced through this hook, so a test can run them by hand.
		schedule: (run) => api.queue.push(run),
		...options
	});
}

beforeEach(() => {
	api = fakeApi({ seq: 11, projects: [aProject()], items: [second, first] });
});

describe('hydrating from the server render', () => {
	it('takes the state and the cursor the page was rendered with', () => {
		const feed = timeline();

		feed.hydrate(api.snapshot());

		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
		expect(feed.projects).toHaveLength(1);
		expect(feed.seq).toBe(11);
		expect(api.calls).toEqual([]);
	});
});

describe('connecting', () => {
	it('resumes the stream from the seq the snapshot was good to', () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());

		feed.start();

		expect(stream.url).toBe('/api/stream?last_event_id=11');
		expect(feed.status).toBe('live');
	});

	it('asks for a snapshot itself when it was never hydrated', async () => {
		const feed = timeline();

		feed.start();
		await api.settle();

		expect(api.calls[0]).toContain('/api/snapshot?');
		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
	});

	it('closes the stream when it stops', () => {
		const feed = timeline();
		feed.start();

		feed.stop();

		expect(stream.closed).toBe(true);
		expect(feed.status).toBe('idle');
	});
});

describe('update.created', () => {
	it('inserts the new update at the top of the timeline', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.publish(third);

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u3', 'u2', 'u1']);
		expect(feed.pendingCount).toBe(0);
	});

	it('marks the arrival as new, so the card can animate in', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.publish(third);

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		expect(feed.isNew('u3')).toBe(true);
		expect(feed.isNew('u1')).toBe(false);
	});

	it('collapses a burst of events into one refetch', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.publish(third);

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		stream.emit('update.created', { seq: 13, payload: { updateId: 'u4' } });
		stream.emit('update.created', { seq: 14, payload: { updateId: 'u5' } });
		await api.settle();

		expect(api.calls).toHaveLength(1);
	});

	it('ignores an event the snapshot already accounted for', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();

		stream.emit('update.created', { seq: 11, payload: { updateId: 'u2' } });
		await api.settle();

		expect(api.calls).toEqual([]);
	});
});

describe('scrolled away from the top', () => {
	it('holds new arrivals back and counts them instead of moving the timeline', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		feed.hold(true);
		api.publish(third);

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
		expect(feed.pendingCount).toBe(1);
	});

	it('releases them when the reader asks for them', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		feed.hold(true);
		api.publish(third);
		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		feed.flush();

		expect(feed.items.map((item) => item.id)).toEqual(['u3', 'u2', 'u1']);
		expect(feed.pendingCount).toBe(0);
		expect(feed.isNew('u3')).toBe(true);
	});

	it('releases them on its own once the reader is back at the top', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		feed.hold(true);
		api.publish(third);
		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		feed.hold(false);

		expect(feed.items.map((item) => item.id)).toEqual(['u3', 'u2', 'u1']);
		expect(feed.pendingCount).toBe(0);
	});
});

describe('update.deleted', () => {
	it('drops the card without a refetch, because the id is the whole payload', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();

		stream.emit('update.deleted', { seq: 12, payload: { updateId: 'u2' } });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u1']);
		expect(api.calls).toEqual([]);
	});

	it('drops one that was still being held back', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		feed.hold(true);
		api.publish(third);
		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();

		stream.emit('update.deleted', { seq: 13, payload: { updateId: 'u3' } });
		await api.settle();

		expect(feed.pendingCount).toBe(0);
		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
	});
});

/**
 * The live swap (design §6 step 5): the one thing the media UI must not fake.
 *
 * `media.ready` carries identifiers, like every other event, so the store's
 * answer is the same as for anything else — refetch the page and reconcile by id
 * — and the new variants arrive on the row that renders them. What these tests
 * pin down is that the store *listens* at all, and that the row it ends up
 * holding is the ready one.
 */
describe('media.ready', () => {
	const pending = anUpdate({
		id: 'u5',
		seq: 20,
		body: 'a screenshot',
		media: [
			aMedia({
				id: 'm1',
				updateId: 'u5',
				status: 'pending',
				width: null,
				height: null,
				variants: []
			})
		]
	});
	const ready = { ...pending, media: [aMedia({ id: 'm1', updateId: 'u5' })] };

	it('refetches the card whose media just became renderable', async () => {
		api = fakeApi({ seq: 20, projects: [aProject()], items: [pending] });
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();

		// The pipeline finished: the same row now answers with its variants.
		api.replace({ items: [ready], seq: 21 });
		stream.emit('media.ready', {
			seq: 21,
			payload: { mediaId: 'm1', updateId: 'u5', kind: 'image' }
		});
		await api.settle();

		expect(feed.items[0].media).toEqual([aMedia({ id: 'm1', updateId: 'u5' })]);
		expect(feed.seq).toBe(21);
	});

	it('replaces the row in place instead of announcing an arrival', async () => {
		api = fakeApi({ seq: 20, projects: [aProject()], items: [pending] });
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		// The reader is somewhere down the timeline, so an *arrival* would be held
		// back and counted. A card the reader is already looking at getting its
		// image is not an arrival, and must not become a "1 new" pill.
		feed.hold(true);

		api.replace({ items: [ready], seq: 21 });
		stream.emit('media.ready', {
			seq: 21,
			payload: { mediaId: 'm1', updateId: 'u5', kind: 'image' }
		});
		await api.settle();

		expect(feed.pendingCount).toBe(0);
		expect(feed.items[0].media?.[0].status).toBe('ready');
	});

	it('ignores one it has already accounted for', async () => {
		api = fakeApi({ seq: 20, projects: [aProject()], items: [pending] });
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();

		// Replay after a reconnect: at or below the snapshot cursor, so there is
		// nothing to go and get.
		stream.emit('media.ready', {
			seq: 20,
			payload: { mediaId: 'm1', updateId: 'u5', kind: 'image' }
		});
		await api.settle();

		expect(api.calls).toEqual([]);
	});
});

describe('resync', () => {
	it('rebuilds from a fresh snapshot rather than trusting what it holds', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		// The server has moved on: u1 is gone and u3 exists, and the gap was too
		// wide for the ring buffer to replay.
		api.replace({ seq: 900, items: [third, second] });

		stream.emit('resync', { seq: 900, reason: 'expired', from: 11 });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u3', 'u2']);
		expect(feed.seq).toBe(900);
	});

	/**
	 * The restart case, which is the one that made the dashboard go quiet.
	 *
	 * `seq` counts from zero in the server's memory and is never persisted, so a
	 * redeployed process starts issuing 1, 2, 3 again. A store that kept the
	 * larger of the two figures would treat every event the new server published
	 * as a replay and drop it, silently, until the page was reloaded.
	 */
	it('rewinds its cursor when the server comes back counting from zero', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		expect(feed.seq).toBe(11);

		api.replace({ seq: 0, items: [second, first] });
		stream.emit('resync', { seq: 0, reason: 'ahead', from: 11 });
		await api.settle();

		expect(feed.seq).toBe(0);

		// And the restarted server's first event actually lands.
		api.replace({ seq: 1, items: [third, second, first] });
		stream.emit('update.created', { seq: 1, payload: { updateId: 'u3', projectId: 'p1' } });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toContain('u3');
	});

	it('does not animate every card as if it were new', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.replace({ seq: 900, items: [third, second] });

		stream.emit('resync', { seq: 900, reason: 'expired', from: 11 });
		await api.settle();

		expect(feed.isNew('u3')).toBe(false);
	});
});

describe('the sidebar staying live', () => {
	it('refetches projects when one is created or changed', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.setProjects([aProject(), aProject({ id: 'p2', slug: 'other', name: 'Other' })]);

		stream.emit('project.created', { seq: 12, payload: { projectId: 'p2', slug: 'other' } });
		await api.settle();

		expect(feed.projects.map((project) => project.slug)).toEqual(['agent-dashboard', 'other']);
	});
});

describe('paging into the past', () => {
	it('appends the older page and carries the cursor forward', async () => {
		api = fakeApi({ seq: 11, projects: [aProject()], items: [second, first], hasMore: true });
		const feed = timeline();
		feed.hydrate(api.snapshot());
		const older = anUpdate({ id: 'u0', seq: 9, body: 'older' });
		api.replace({ seq: 11, items: [older], hasMore: false });

		await feed.loadOlder();

		expect(api.calls[0]).toContain('cursor=10');
		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1', 'u0']);
		expect(feed.hasMore).toBe(false);
	});

	it('does nothing when there is nothing older', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());

		await feed.loadOlder();

		expect(api.calls).toEqual([]);
	});
});

describe('who posted what', () => {
	it('adopts the agent names the page was rendered with', () => {
		api = fakeApi({
			seq: 11,
			projects: [aProject()],
			items: [second, first],
			agentNames: { a1: 'docs-writer' }
		});
		const feed = timeline();

		feed.hydrate(api.snapshot());

		expect(feed.agentNames).toEqual({ a1: 'docs-writer' });
	});

	it('learns the name of an agent that appeared after the page loaded', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		api.replace({ seq: 12, items: [third, second, first], agentNames: { a1: 'build-bot' } });

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3', projectId: 'p1' } });
		await api.settle();

		expect(feed.agentNames).toEqual({ a1: 'build-bot' });
	});

	it('keeps the names it holds when a page of the timeline carries none', async () => {
		// `/api/snapshot/updates` is updates and nothing else. A store that took
		// its silence for "no agents have names" would blank every card header on
		// the first click of "load older".
		api = fakeApi({
			seq: 11,
			projects: [aProject()],
			items: [second, first],
			hasMore: true,
			agentNames: { a1: 'docs-writer' }
		});
		const feed = timeline();
		feed.hydrate(api.snapshot());
		api.replace({ items: [anUpdate({ id: 'u0', seq: 9 })], hasMore: false });

		await feed.loadOlder();

		expect(feed.agentNames).toEqual({ a1: 'docs-writer' });
	});
});

describe('one project at a time', () => {
	it('scopes every request to the selected project', async () => {
		const feed = timeline({ project: 'agent-dashboard' });

		feed.start();
		await api.settle();

		expect(api.calls[0]).toContain('project=agent-dashboard');
	});

	it('ignores an update posted into a project it is not showing', async () => {
		// One stream carries every project, so a busy deployment would otherwise
		// have every page refetching a timeline that cannot have changed.
		const feed = timeline({ project: 'agent-dashboard' });
		feed.hydrate(api.snapshot());
		feed.start();

		stream.emit('update.created', { seq: 12, payload: { updateId: 'x1', projectId: 'p9' } });
		await api.settle();

		expect(api.calls).toEqual([]);
	});

	it('still refetches for a project it has never heard of', async () => {
		// A project created since this page loaded. "Not in my list" is not the
		// same claim as "not mine", and guessing wrong here loses updates.
		const feed = timeline({ project: 'unknown-so-far' });
		feed.hydrate(api.snapshot());
		feed.start();

		stream.emit('update.created', { seq: 12, payload: { updateId: 'x1', projectId: 'p9' } });
		await api.settle();

		expect(api.calls).toHaveLength(1);
	});

	it('keeps refetching for its own project', async () => {
		const feed = timeline({ project: 'agent-dashboard' });
		feed.hydrate(api.snapshot());
		feed.start();
		api.publish(third);

		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3', projectId: 'p1' } });
		await api.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u3', 'u2', 'u1']);
	});
});

/**
 * Filtering the feed to one task (design §7).
 *
 * Server-side rather than over what is already loaded: the browser holds one
 * page of the timeline, and a task's history can run further back than that page
 * reaches — a client-side filter would show a fraction of the work and look like
 * all of it.
 */
describe('filtering by task', () => {
	it('asks the server for that task’s updates', async () => {
		const api = fakeApi({ seq: 1, projects: [], items: [anUpdate()] });
		const feed = new Timeline({ fetch: api.fetch, schedule: (run) => run() });
		feed.hydrate(api.snapshot());

		await feed.filterByTask('t1');

		expect(api.calls.at(-1)).toContain('task=t1');
		expect(feed.task).toBe('t1');
	});

	it('clears it again', async () => {
		const api = fakeApi({ seq: 1, projects: [], items: [anUpdate()] });
		const feed = new Timeline({ fetch: api.fetch, schedule: (run) => run() });
		feed.hydrate(api.snapshot());
		await feed.filterByTask('t1');

		await feed.filterByTask(null);

		expect(feed.task).toBeNull();
		expect(api.calls.at(-1)).not.toContain('task=');
	});

	it('does nothing when the filter is already what was asked for', async () => {
		const api = fakeApi({ seq: 1, projects: [], items: [anUpdate()] });
		const feed = new Timeline({ fetch: api.fetch, schedule: (run) => run() });
		feed.hydrate(api.snapshot());
		await feed.filterByTask('t1');
		const before = api.calls.length;

		await feed.filterByTask('t1');

		expect(api.calls.length).toBe(before);
	});

	it('drops arrivals counted against the feed it is leaving', async () => {
		const feed = timeline();
		feed.hydrate(api.snapshot());
		feed.start();
		feed.hold(true);
		api.publish(third);
		stream.emit('update.created', { seq: 12, payload: { updateId: 'u3' } });
		await api.settle();
		expect(feed.pendingCount).toBe(1);

		await feed.filterByTask('t1');

		// Those "N new" were counted against a feed that no longer exists, and
		// offering them after the filter would promise updates that do not match it.
		expect(feed.pendingCount).toBe(0);
		feed.stop();
	});
});
