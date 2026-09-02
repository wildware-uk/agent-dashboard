import { describe, expect, it } from 'vitest';
import { EventBus } from '$events';
import { insertMedia } from '$db';
import { createProject, notFound, postUpdate, updateProject } from '$domain';
import { harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import {
	SNAPSHOT_DEFAULT_LIMIT,
	createSnapshotHandler,
	readFullSnapshot,
	readSnapshotQuery,
	readUpdatesSnapshot,
	type SnapshotQuery
} from './snapshot';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

type Options = { cookie?: string; read?: (query: SnapshotQuery) => object; bus?: EventBus };

async function get(path: string, options: Options = {}) {
	const bus = options.bus ?? new EventBus();
	const handler = createSnapshotHandler({
		bus,
		config,
		read: options.read ?? (() => ({ projects: [] }))
	});
	const url = new URL(`http://dash.test${path}`);
	const cookie = options.cookie ?? signSession(SESSION_SECRET);
	const response = handler({
		request: new Request(url),
		url,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	});

	return {
		response,
		body: response.status === 200 ? await response.json() : await response.json()
	};
}

describe('the snapshot a resyncing client refetches', () => {
	it('stamps the state with the stream cursor it is good to', async () => {
		const bus = new EventBus();
		bus.publish('project.created', { projectId: 'p1', slug: 'p1' });

		const { body } = await get('/api/snapshot', { bus });

		expect(body.seq).toBe(bus.lastSeq);
		expect(typeof body.at).toBe('string');
	});

	it('reads the cursor before the state, so no event can fall between them', async () => {
		const bus = new EventBus();
		const read = () => {
			// Something published while the snapshot was being read. The client must
			// see this event on the stream, which it only will if the snapshot claims
			// the *earlier* cursor.
			bus.publish('project.created', { projectId: 'late', slug: 'late' });
			return { projects: [] };
		};

		const { body } = await get('/api/snapshot', { bus, read });

		expect(body.seq).toBe(0);
		expect(bus.lastSeq).toBe(1);
	});

	it('returns whatever the reader read, unreshaped', async () => {
		const read = () => ({
			projects: [{ id: 'p1', slug: 'dash' }],
			updates: { items: [{ id: 'u1' }], nextCursor: null, hasMore: false }
		});

		const { response, body } = await get('/api/snapshot', { read });

		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(body).toMatchObject(read());
	});

	it('hands the reader the query the client asked for', async () => {
		const seen: SnapshotQuery[] = [];

		await get('/api/snapshot?project=dash&limit=5&cursor=abc&status=archived', {
			read: (query) => {
				seen.push(query);
				return { projects: [] };
			}
		});

		expect(seen).toEqual([{ project: 'dash', status: 'archived', limit: 5, cursor: 'abc' }]);
	});

	it('reports a domain failure as the status it maps to, not a 500', async () => {
		const { response, body } = await get('/api/snapshot?project=nope', {
			read: () => {
				throw notFound('no project nope');
			}
		});

		expect(response.status).toBe(404);
		expect(body).toEqual({ error: 'not_found', message: 'no project nope' });
	});

	it('refuses a request without an owner session', async () => {
		const { response, body } = await get('/api/snapshot', { cookie: '' });

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
	});
});

describe('reading the query string', () => {
	it('defaults to the whole timeline with a sensible page size', () => {
		expect(readSnapshotQuery(new URL('http://dash.test/api/snapshot'))).toEqual({
			limit: SNAPSHOT_DEFAULT_LIMIT
		});
	});

	it('keeps a project reference verbatim, slug or id', () => {
		expect(readSnapshotQuery(new URL('http://dash.test/x?project=dash')).project).toBe('dash');
	});

	it('ignores a limit that is not a positive integer', () => {
		for (const raw of ['0', '-3', 'ten', '1.5', '']) {
			expect(readSnapshotQuery(new URL(`http://dash.test/x?limit=${raw}`)).limit).toBe(
				SNAPSHOT_DEFAULT_LIMIT
			);
		}
	});

	it('ignores a status outside the two the schema allows', () => {
		expect(readSnapshotQuery(new URL('http://dash.test/x?status=deleted')).status).toBeUndefined();
		expect(readSnapshotQuery(new URL('http://dash.test/x?status=active')).status).toBe('active');
	});
});

describe('reading the real state through the domain', () => {
	/** A deployment with two projects and four updates in the first of them. */
	function seeded() {
		const ctx = harness();
		const agentId = ctx.agent();
		const { project } = createProject(ctx, { name: 'Agent Dashboard' });
		const retired = createProject(ctx, { name: 'Retired' }).project;
		updateProject(ctx, retired.slug, { status: 'archived' });
		for (const body of ['one', 'two', 'three', 'four']) {
			postUpdate(ctx, { project: project.slug, agentId, body });
		}
		return { ctx, project };
	}

	it('returns the projects and the newest updates, with a page cursor', () => {
		const { ctx, project } = seeded();

		const snapshot = readFullSnapshot({ limit: 2 }, ctx);

		// `listProjects` orders pinned first, then newest: the archived project was
		// created second, so it leads.
		expect(snapshot.projects.map((p) => p.slug)).toEqual(['retired', project.slug]);
		expect(snapshot.updates.items.map((u) => u.body)).toEqual(['four', 'three']);
		expect(snapshot.updates.hasMore).toBe(true);
		expect(snapshot.updates.nextCursor).not.toBeNull();
	});

	it('pages further back with the cursor it handed out', () => {
		const { ctx } = seeded();

		const first = readFullSnapshot({ limit: 2 }, ctx);
		const second = readUpdatesSnapshot(
			{ limit: 2, cursor: first.updates.nextCursor ?? undefined },
			ctx
		);

		expect(second.updates.items.map((u) => u.body)).toEqual(['two', 'one']);
		expect(second.updates.hasMore).toBe(false);
		expect(second).not.toHaveProperty('projects');
	});

	it('carries a name for every agent in the timeline, online or long gone', () => {
		const ctx = harness();
		const writer = ctx.agent('docs-writer');
		const bot = ctx.agent('build-bot');
		const { project } = createProject(ctx, { name: 'Agent Dashboard' });
		postUpdate(ctx, { project: project.slug, agentId: writer, body: 'wrote the docs' });
		postUpdate(ctx, { project: project.slug, agentId: bot, body: 'green' });

		const snapshot = readFullSnapshot({ limit: 10 }, ctx);

		// Neither agent has ever registered a session, so presence knows nothing
		// about either of them — and the cards still have to say who posted (#20).
		expect(snapshot.agentNames).toEqual({ [writer]: 'docs-writer', [bot]: 'build-bot' });
	});

	/**
	 * Media rides on the card it belongs to (design §7).
	 *
	 * The alternative — a map beside the timeline — would need the client to keep
	 * two things reconciled, and `media.ready` is answered by refetching the page
	 * of updates: the row the client replaces has to arrive carrying its own
	 * media, or the swap is a second request the transport never asked for.
	 */
	it('hangs each update`s media on the update itself, sized and with its variants', () => {
		const ctx = harness();
		const agentId = ctx.agent();
		const { project } = createProject(ctx, { name: 'Agent Dashboard' });
		const media = insertMedia(ctx.db, {
			agentId,
			kind: 'image',
			mime: 'image/png',
			bytes: 4321,
			sha256: 'abc',
			width: 1200,
			height: 800
		});
		const update = postUpdate(ctx, {
			project: project.slug,
			agentId,
			body: 'a shot',
			mediaIds: [media.id]
		});
		postUpdate(ctx, { project: project.slug, agentId, body: 'no shot' });

		const snapshot = readFullSnapshot({ limit: 10 }, ctx);
		const [plain, withMedia] = snapshot.updates.items;

		expect(withMedia.id).toBe(update.id);
		expect(withMedia.media).toEqual([
			{
				id: media.id,
				updateId: update.id,
				kind: 'image',
				// Migration 016: an image can hang off a message instead. A card's
				// media says so by carrying null here.
				messageId: null,
				mime: 'image/png',
				status: 'pending',
				width: 1200,
				height: 800,
				durationMs: null,
				variants: ['original']
			}
		]);
		// Never absent: a card that reads `media.length` must not have to guard.
		expect(plain.media).toEqual([]);
	});

	it('carries media on a page read through the updates-only endpoint too', () => {
		const ctx = harness();
		const agentId = ctx.agent();
		const { project } = createProject(ctx, { name: 'Agent Dashboard' });
		const media = insertMedia(ctx.db, {
			agentId,
			kind: 'video',
			mime: 'video/mp4',
			bytes: 900,
			sha256: 'def',
			durationMs: 7000
		});
		postUpdate(ctx, { project: project.slug, agentId, body: 'a clip', mediaIds: [media.id] });

		// This is the endpoint "load older" reads, and the one the store refetches
		// on `media.ready` — so it has to answer with the same shape.
		const snapshot = readUpdatesSnapshot({ limit: 10 }, ctx);

		expect(snapshot.updates.items[0].media.map((item) => item.kind)).toEqual(['video']);
		expect(snapshot.updates.items[0].media[0].durationMs).toBe(7000);
	});

	it('filters the project list by status when asked', () => {
		const { ctx } = seeded();

		const snapshot = readFullSnapshot({ limit: 10, status: 'archived' }, ctx);

		expect(snapshot.projects.map((p) => p.slug)).toEqual(['retired']);
	});

	it('answers an unknown project with a 404 through the handler', async () => {
		const { ctx } = seeded();
		const handler = createSnapshotHandler({
			read: (query) => readFullSnapshot(query, ctx),
			bus: ctx.bus,
			config
		});
		const url = new URL('http://dash.test/api/snapshot?project=no-such-thing');

		const response = handler({
			request: new Request(url),
			url,
			cookies: { get: () => signSession(SESSION_SECRET) }
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
	});

	it('serves a scoped timeline the stream can be reconciled against', async () => {
		const { ctx, project } = seeded();
		const handler = createSnapshotHandler({
			read: (query) => readFullSnapshot(query, ctx),
			bus: ctx.bus,
			config
		});
		const url = new URL(`http://dash.test/api/snapshot?project=${project.slug}&limit=10`);

		const response = handler({
			request: new Request(url),
			url,
			cookies: { get: () => signSession(SESSION_SECRET) }
		});
		const body = await response.json();

		expect(body.seq).toBe(ctx.bus.lastSeq);
		expect(body.updates.items).toHaveLength(4);
	});
});
