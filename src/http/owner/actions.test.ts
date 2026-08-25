import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listProjects, listUpdates, postUpdate } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import {
	createProjectHandler,
	deleteUpdateHandler,
	patchProjectHandler,
	patchUpdateHandler,
	type OwnerHandler
} from './actions';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent();
});

type CallOptions = {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
	/** Signed session by default; pass `null` for a caller with no cookie. */
	cookie?: string | null;
	/** Raw body, for the malformed-JSON case. */
	raw?: string;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({ ctx: () => h, config });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const init: RequestInit = { method: options.method ?? 'POST' };
	if (options.raw !== undefined) init.body = options.raw;
	else if (options.body !== undefined) init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request('http://dash.test/api/x', init),
		params: options.params ?? {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

describe('creating a project from the browser', () => {
	it('creates it, answers 201, and publishes project.created', async () => {
		const { response, body } = await call(createProjectHandler, {
			body: { name: 'Agent Dashboard', description: 'the one' }
		});

		expect(response.status).toBe(201);
		expect(body.project).toMatchObject({
			slug: 'agent-dashboard',
			name: 'Agent Dashboard',
			description: 'the one',
			status: 'active',
			pinned: false
		});
		expect(body.created).toBe(true);
		expect(h.eventNames()).toEqual(['project.created']);
		expect(listProjects(h)).toHaveLength(1);
	});

	it('is idempotent on slug: the second POST answers 200 and publishes nothing', async () => {
		await call(createProjectHandler, { body: { name: 'Agent Dashboard' } });
		h.events.length = 0;

		const { response, body } = await call(createProjectHandler, {
			body: { name: 'Agent Dashboard' }
		});

		expect(response.status).toBe(200);
		expect(body.created).toBe(false);
		expect(h.events).toEqual([]);
	});

	it('rejects a blank name with the domain code the browser can branch on', async () => {
		const { response, body } = await call(createProjectHandler, { body: { name: '   ' } });

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('rejects a body that is not an object', async () => {
		const { response, body } = await call(createProjectHandler, { body: ['Agent Dashboard'] });

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('rejects a body that is not JSON at all', async () => {
		const { response } = await call(createProjectHandler, { raw: 'name=dash' });

		expect(response.status).toBe(400);
	});

	it('refuses a caller with no owner session, and writes nothing', async () => {
		const { response, body } = await call(createProjectHandler, {
			body: { name: 'Agent Dashboard' },
			cookie: null
		});

		expect(response.status).toBe(401);
		expect(body.error).toBe('unauthenticated');
		expect(listProjects(h)).toEqual([]);
	});
});

describe('curating a project', () => {
	let slug: string;

	beforeEach(() => {
		slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
		h.events.length = 0;
	});

	async function patch(body: unknown, reference = slug) {
		return call(patchProjectHandler, { method: 'PATCH', body, params: { reference } });
	}

	it('renames it and publishes project.updated', async () => {
		const { response, body } = await patch({ name: 'Dashboard' });

		expect(response.status).toBe(200);
		expect(body.project.name).toBe('Dashboard');
		expect(h.eventNames()).toEqual(['project.updated']);
	});

	it('edits the description, including clearing it', async () => {
		await patch({ description: 'watch the agents' });
		const { body } = await patch({ description: null });

		expect(body.project.description).toBeNull();
	});

	it('pins and unpins it', async () => {
		expect((await patch({ pinned: true })).body.project.pinned).toBe(true);
		expect((await patch({ pinned: false })).body.project.pinned).toBe(false);
	});

	it('archives and unarchives it, and the updates stay', async () => {
		postUpdate(h, { project: slug, agentId, body: 'shipped it' });

		const archived = await patch({ status: 'archived' });

		expect(archived.body.project.status).toBe('archived');
		expect(listProjects(h, { status: 'active' })).toEqual([]);
		expect(listUpdates(h, { project: slug }).updates).toHaveLength(1);
		expect((await patch({ status: 'active' })).body.project.status).toBe('active');
	});

	it('takes an id as happily as a slug', async () => {
		const project = listProjects(h)[0];

		const { response } = await patch({ pinned: true }, project.id);

		expect(response.status).toBe(200);
	});

	it('refuses a status it has never heard of', async () => {
		const { response, body } = await patch({ status: 'deleted' });

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
		expect(h.events).toEqual([]);
	});

	it('refuses a pinned flag that is not a boolean', async () => {
		expect((await patch({ pinned: 'yes' })).response.status).toBe(400);
	});

	it('refuses an empty patch rather than publishing a pointless event', async () => {
		expect((await patch({})).response.status).toBe(400);
		expect(h.events).toEqual([]);
	});

	it('ignores fields the browser has no business sending', async () => {
		const { response, body } = await patch({ pinned: true, seq: 99, id: 'nope' });

		expect(response.status).toBe(200);
		expect(body.project.id).not.toBe('nope');
	});

	it('answers 404 for a project that does not exist', async () => {
		const { response, body } = await patch({ pinned: true }, 'ghost');

		expect(response.status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('answers 409 when a rename would steal another project’s slug', async () => {
		createProject(h, { name: 'Other' });

		const { response, body } = await patch({ slug: 'other' });

		expect(response.status).toBe(409);
		expect(body.error).toBe('conflict');
	});

	it('refuses a caller with no owner session', async () => {
		const { response } = await call(patchProjectHandler, {
			method: 'PATCH',
			body: { name: 'Stolen' },
			params: { reference: slug },
			cookie: null
		});

		expect(response.status).toBe(401);
		expect(listProjects(h)[0].name).toBe('Agent Dashboard');
	});
});

describe('curating an update', () => {
	let updateId: string;

	beforeEach(() => {
		createProject(h, { name: 'Agent Dashboard' });
		updateId = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' }).id;
		h.events.length = 0;
	});

	it('pins it and publishes update.updated', async () => {
		const { response, body } = await call(patchUpdateHandler, {
			method: 'PATCH',
			body: { pinned: true },
			params: { id: updateId }
		});

		expect(response.status).toBe(200);
		expect(body.update.pinned).toBe(true);
		expect(h.eventNames()).toEqual(['update.updated']);
	});

	it('refuses a patch that is not about pinning', async () => {
		const { response, body } = await call(patchUpdateHandler, {
			method: 'PATCH',
			body: { body: 'rewritten by the owner' },
			params: { id: updateId }
		});

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
		expect(listUpdates(h).updates[0].body).toBe('shipped it');
	});

	it('soft-deletes it and publishes update.deleted', async () => {
		const { response, body } = await call(deleteUpdateHandler, {
			method: 'DELETE',
			params: { id: updateId }
		});

		expect(response.status).toBe(200);
		expect(body.update.deletedAt).toBeTypeOf('number');
		expect(h.eventNames()).toEqual(['update.deleted']);
		expect(listUpdates(h).updates).toEqual([]);
		expect(listUpdates(h, { includeDeleted: true }).updates).toHaveLength(1);
	});

	it('answers 404 for an update that does not exist', async () => {
		const { response } = await call(deleteUpdateHandler, {
			method: 'DELETE',
			params: { id: 'ghost' }
		});

		expect(response.status).toBe(404);
	});

	it('refuses an unauthenticated delete, and the update survives', async () => {
		const { response } = await call(deleteUpdateHandler, {
			method: 'DELETE',
			params: { id: updateId },
			cookie: null
		});

		expect(response.status).toBe(401);
		expect(listUpdates(h).updates).toHaveLength(1);
	});
});
