import { beforeEach, describe, expect, it } from 'vitest';
import { claimTask, createProject, createTask, listTasks } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import {
	createTaskHandler,
	markProjectSeenHandler,
	patchTaskHandler,
	type OwnerHandler
} from './actions';

/**
 * The owner's half of the control plane (design §7): putting work on a project,
 * pointing it at an agent, and taking it back off again. Claiming and completing
 * are the agent's over MCP, and there is deliberately no endpoint here for them.
 */
const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	createProject(h, { name: 'Agent Dashboard' });
});

type CallOptions = {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
	/** Signed session by default; pass `null` for a caller with no cookie. */
	cookie?: string | null;
	raw?: string;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({ ctx: () => h, config });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const init: RequestInit = { method: options.method ?? 'POST' };
	if (options.raw !== undefined) init.body = options.raw;
	else if (options.body !== undefined) init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request('http://dash.test/api/tasks', init),
		params: options.params ?? {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

describe('creating a task from the browser', () => {
	it('creates it, answers 201, and publishes task.created', async () => {
		const { response, body } = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 'Ship tasks', body: 'the brief' }
		});

		expect(response.status).toBe(201);
		expect(body.task).toMatchObject({
			title: 'Ship tasks',
			body: 'the brief',
			state: 'todo',
			agentId: null
		});
		expect(h.eventNames()).toEqual(['project.created', 'task.created']);
		expect(listTasks(h)).toHaveLength(1);
	});

	it('targets one agent when the owner picked one', async () => {
		const { body } = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 'Yours', agentId }
		});

		expect(body.task).toMatchObject({ agentId, state: 'todo' });
	});

	it('maps a domain refusal onto the status it means', async () => {
		const unknown = await call(createTaskHandler, {
			body: { project: 'nope', title: 'x' }
		});
		expect(unknown.response.status).toBe(404);
		expect(unknown.body).toMatchObject({ error: 'not_found' });

		const blank = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: '  ' }
		});
		expect(blank.response.status).toBe(400);
		expect(blank.body).toMatchObject({ error: 'invalid_argument' });

		const wrongType = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 7 }
		});
		expect(wrongType.response.status).toBe(400);

		const malformed = await call(createTaskHandler, { raw: 'not json' });
		expect(malformed.response.status).toBe(400);
		expect(listTasks(h)).toEqual([]);
	});

	it('refuses a caller with no session, and writes nothing', async () => {
		const { response, body } = await call(createTaskHandler, {
			cookie: null,
			body: { project: 'agent-dashboard', title: 'sneaky' }
		});

		expect(response.status).toBe(401);
		expect(body.error).toBe('unauthenticated');
		expect(listTasks(h)).toEqual([]);
	});
});

describe('reassigning and cancelling a task', () => {
	it('reassigns an open task and publishes task.updated', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'somebody' });
		h.events.length = 0;

		const { response, body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { agentId }
		});

		expect(response.status).toBe(200);
		expect(body.task).toMatchObject({ agentId, state: 'todo' });
		expect(h.eventNames()).toEqual(['task.updated']);
	});

	it('unassigns it when the owner picks nobody', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'mine', agentId });

		const { body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { agentId: null }
		});

		expect(body.task.agentId).toBeNull();
	});

	it('cancels a task the owner has changed their mind about', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'never mind' });

		const { response, body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { state: 'cancelled' }
		});

		expect(response.status).toBe(200);
		expect(body.task.state).toBe('cancelled');
		// And a second cancel is a 409 rather than a silent success.
		const again = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { state: 'cancelled' }
		});
		expect(again.response.status).toBe(409);
	});

	it('will not let a browser mark work done, or invent a state', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'mine', agentId });
		claimTask(h, { taskId: task.id, agentId });

		for (const patch of [{ state: 'done' }, { state: 'todo' }, { result: 'faked it' }, {}]) {
			const { response, body } = await call(patchTaskHandler, {
				method: 'PATCH',
				params: { id: task.id },
				body: patch
			});

			expect(response.status, JSON.stringify(patch)).toBe(400);
			expect(body.error).toBe('invalid_argument');
		}
		expect(listTasks(h)[0]).toMatchObject({ state: 'claimed', agentId });
	});

	it('answers 404 for a task that is not there, and 401 with no session', async () => {
		const missing = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: 'nope' },
			body: { agentId: null }
		});
		expect(missing.response.status).toBe(404);

		const task = createTask(h, { project: 'agent-dashboard', title: 'safe' });
		const guarded = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			cookie: null,
			body: { state: 'cancelled' }
		});
		expect(guarded.response.status).toBe(401);
		expect(listTasks(h)[0].state).toBe('todo');
	});
});

describe('sending a task to a project’s agents', () => {
	it('stamps it, answers 200, and publishes task.updated', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'anybody?' });

		const { response, body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: true }
		});

		expect(response.status).toBe(200);
		expect(body.task.broadcastAt).not.toBeNull();
		expect(h.eventNames()).toContain('task.updated');
	});

	it('takes it back off the wire', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'never mind' });
		await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: true }
		});

		const { body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: false }
		});

		expect(body.task.broadcastAt).toBeNull();
	});

	it('answers 409 for work somebody is already holding', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'taken' });
		claimTask(h, { taskId: task.id, agentId });

		const { response, body } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: true }
		});

		expect(response.status).toBe(409);
		expect(body.error).toBe('conflict');
	});

	it('refuses a patch that broadcasts and reassigns at once, rather than picking an order', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'both' });

		const { response } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: true, agentId }
		});

		expect(response.status).toBe(400);
		expect(listTasks(h, {})[0].broadcastAt).toBeNull();
	});

	it('refuses a broadcast that is not a boolean', async () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'nope' });

		const { response } = await call(patchTaskHandler, {
			method: 'PATCH',
			params: { id: task.id },
			body: { broadcast: 'yes' }
		});

		expect(response.status).toBe(400);
	});
});

describe('marking a project seen', () => {
	it('stamps it and answers the project', async () => {
		const { response, body } = await call(markProjectSeenHandler, {
			params: { reference: 'agent-dashboard' }
		});

		expect(response.status).toBe(200);
		expect(body.project.ownerSeenAt).not.toBeNull();
	});

	it('answers 404 for a project that is not there', async () => {
		const { response } = await call(markProjectSeenHandler, { params: { reference: 'nope' } });

		expect(response.status).toBe(404);
	});

	it('refuses a caller with no session: what the owner has read is not public', async () => {
		const { response } = await call(markProjectSeenHandler, {
			params: { reference: 'agent-dashboard' },
			cookie: null
		});

		expect(response.status).toBe(401);
	});
});

/**
 * The board's one-line composer, over HTTP: one request, offered to everybody.
 */
describe('handing work to a project in one request', () => {
	it('creates it already broadcast, with no assignee', async () => {
		const { response, body } = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 'somebody look at this', broadcast: true }
		});

		expect(response.status).toBe(201);
		expect(body.task.broadcastAt).not.toBeNull();
		expect(body.task.agentId).toBeNull();
	});

	it('carries the brief when the owner typed more than a line', async () => {
		const { body } = await call(createTaskHandler, {
			body: {
				project: 'agent-dashboard',
				title: 'fix the flaky test',
				body: 'only on CI, around midnight',
				broadcast: true
			}
		});

		expect(body.task.body).toBe('only on CI, around midnight');
	});

	it('refuses to assign and broadcast at once', async () => {
		const { response } = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 'both', agentId, broadcast: true }
		});

		expect(response.status).toBe(400);
		expect(listTasks(h, {})).toEqual([]);
	});

	it('refuses a broadcast that is not a boolean', async () => {
		const { response } = await call(createTaskHandler, {
			body: { project: 'agent-dashboard', title: 'nope', broadcast: 'yes' }
		});

		expect(response.status).toBe(400);
	});
});
