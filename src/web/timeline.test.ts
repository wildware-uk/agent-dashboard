import { beforeEach, describe, expect, it } from 'vitest';
import { Timeline, type TimelineOptions } from './timeline.svelte';
import { FakeStream, aProject, anUpdate, fakeApi } from './testing';

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
