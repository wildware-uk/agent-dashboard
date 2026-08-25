import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, postUpdate } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { Timeline } from '$web';
import { FakeStream } from '$web/testing';
import type { SnapshotResponse } from '$web';
import { SESSION_COOKIE, signSession } from '../auth';
import { createSnapshotHandler, readFullSnapshot, readUpdatesSnapshot } from '../stream';
import {
	createProjectHandler,
	deleteUpdateHandler,
	patchProjectHandler,
	patchUpdateHandler,
	type OwnerHandler
} from './actions';

/**
 * The acceptance criterion this whole slice exists for: an owner action in one
 * tab reaches a second tab that nobody touched.
 *
 * Everything below the browser is real — the domain, the bus, the snapshot
 * endpoint and the owner endpoints, all against one in-memory database. The two
 * fakes are the two things a Node test cannot have: `EventSource` (the bus is
 * piped into a `FakeStream` per tab, exactly as `GET /api/stream` pipes it into
 * a real one) and the network (`fetch` calls the snapshot handler directly).
 *
 * So what is under test is the join: a write publishes, the stream carries it,
 * and the tab that was only watching refetches and agrees.
 */

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });
const cookies = {
	get: (name: string) => (name === SESSION_COOKIE ? signSession(SESSION_SECRET) : undefined)
};

let h: Harness;
let agentId: string;
/** Every refetch the tabs have queued, run by hand so the test controls timing. */
let queue: (() => void)[];
let streams: FakeStream[];

function snapshotFetch(url: string): Promise<Response> {
	const target = new URL(url, 'http://dash.test');
	const handler = target.pathname.endsWith('/updates')
		? createSnapshotHandler({ read: (query) => readUpdatesSnapshot(query, h), config })
		: createSnapshotHandler({ read: (query) => readFullSnapshot(query, h), config });
	return Promise.resolve(handler({ request: new Request(target), url: target, cookies }));
}

/** What the server render embeds: the cursor first, then the state (design §4). */
function serverRender(project?: string): SnapshotResponse {
	const seq = h.bus.lastSeq;
	return {
		seq,
		at: new Date().toISOString(),
		...readFullSnapshot({ limit: 50, ...(project ? { project } : {}) }, h)
	};
}

/** One open browser tab: a hydrated store on its own stream. */
function tab() {
	const stream = new FakeStream();
	streams.push(stream);
	const feed = new Timeline({
		fetch: snapshotFetch,
		openStream: () => stream,
		schedule: (run) => queue.push(run)
	});
	feed.hydrate(serverRender());
	feed.start();
	return feed;
}

/** Run every queued refetch and let its promises settle. */
async function settle(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) {
		while (queue.length > 0) queue.shift()!();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function act(
	factory: (options: object) => OwnerHandler,
	path: string,
	init: RequestInit,
	params: Record<string, string> = {}
) {
	const handler = factory({ ctx: () => h, config });
	const response = await handler({
		request: new Request(`http://dash.test${path}`, init),
		params,
		cookies
	});
	expect(response.status).toBeLessThan(300);
	await settle();
	return response;
}

const patchProject = (reference: string, patch: unknown) =>
	act(
		patchProjectHandler,
		`/api/projects/${reference}`,
		{ method: 'PATCH', body: JSON.stringify(patch) },
		{ reference }
	);

const patchUpdate = (id: string, patch: unknown) =>
	act(
		patchUpdateHandler,
		`/api/updates/${id}`,
		{ method: 'PATCH', body: JSON.stringify(patch) },
		{ id }
	);

beforeEach(() => {
	h = harness();
	agentId = h.agent();
	queue = [];
	streams = [];
	// The bus is the only wire between a write and the tabs, so this subscription
	// is the whole SSE fan-out: every published event reaches every open stream.
	h.bus.subscribe((event) => {
		for (const stream of streams)
			stream.emit(event.type, { seq: event.seq, payload: event.payload });
	});
});

describe('two open tabs', () => {
	let updateId: string;

	beforeEach(() => {
		createProject(h, { name: 'Agent Dashboard' });
		updateId = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' }).id;
	});

	it('both follow a rename made in neither of them', async () => {
		const [acting, watching] = [tab(), tab()];

		await patchProject('agent-dashboard', { name: 'Dashboard' });

		expect(acting.projects[0].name).toBe('Dashboard');
		expect(watching.projects[0].name).toBe('Dashboard');
	});

	it('both follow a pin, and both put the pinned project first', async () => {
		createProject(h, { name: 'Second' });
		const [acting, watching] = [tab(), tab()];

		await patchProject('agent-dashboard', { pinned: true });

		for (const feed of [acting, watching]) {
			expect(feed.projects.map((project) => project.slug)).toEqual(['agent-dashboard', 'second']);
			expect(feed.projects[0].pinned).toBe(true);
		}
	});

	it('both follow an archive, and neither loses the project’s updates', async () => {
		const [acting, watching] = [tab(), tab()];

		await patchProject('agent-dashboard', { status: 'archived' });

		for (const feed of [acting, watching]) {
			expect(feed.projects[0].status).toBe('archived');
			// Archiving is a status change, not a delete (design §3, §7).
			expect(feed.items.map((item) => item.id)).toEqual([updateId]);
		}
	});

	it('both see a project created from one of them', async () => {
		const [acting, watching] = [tab(), tab()];

		await act(createProjectHandler, '/api/projects', {
			method: 'POST',
			body: JSON.stringify({ name: 'Brand New' })
		});

		for (const feed of [acting, watching]) {
			expect(feed.projects.map((project) => project.slug)).toContain('brand-new');
		}
	});

	it('both drop a deleted update, without either refetching it back', async () => {
		const [acting, watching] = [tab(), tab()];

		await act(
			deleteUpdateHandler,
			`/api/updates/${updateId}`,
			{ method: 'DELETE' },
			{ id: updateId }
		);

		expect(acting.items).toEqual([]);
		expect(watching.items).toEqual([]);
	});

	it('both see an update pinned in the other', async () => {
		const [acting, watching] = [tab(), tab()];

		await patchUpdate(updateId, { pinned: true });

		expect(acting.items[0].pinned).toBe(true);
		expect(watching.items[0].pinned).toBe(true);
	});

	it('leaves a tab scoped to another project alone', async () => {
		createProject(h, { name: 'Second' });
		const elsewhere = new Timeline({
			project: 'second',
			fetch: snapshotFetch,
			openStream: () => {
				const stream = new FakeStream();
				streams.push(stream);
				return stream;
			},
			schedule: (run) => queue.push(run)
		});
		elsewhere.hydrate(serverRender('second'));
		elsewhere.start();

		await patchUpdate(updateId, { pinned: true });

		// The event was about the other project's update, so this tab has nothing
		// to refetch — but it must still bank the cursor it just saw.
		expect(elsewhere.items).toEqual([]);
		expect(elsewhere.seq).toBe(h.bus.lastSeq);
	});
});
