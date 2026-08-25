import { describe, expect, it } from 'vitest';
import { ActionError, ownerActions } from './actions';
import { aProject, anUpdate } from './testing';

type Call = { url: string; init: RequestInit };

/** A fake `fetch` that records what it was asked and answers with `reply`. */
function recorder(reply: () => Response) {
	const calls: Call[] = [];
	const request = (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve(reply());
	};
	return { calls, request };
}

function jsonReply(status: number, body: unknown) {
	return () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
}

function bodyOf(call: Call): unknown {
	return JSON.parse(String(call.init.body));
}

describe('creating a project', () => {
	it('posts the form to /api/projects and hands back the project', async () => {
		const project = aProject({ name: 'Dash' });
		const { calls, request } = recorder(jsonReply(201, { project, created: true }));

		const created = await ownerActions(request).createProject({
			name: 'Dash',
			description: 'watch the agents'
		});

		expect(created).toEqual(project);
		expect(calls[0].url).toBe('/api/projects');
		expect(calls[0].init.method).toBe('POST');
		expect(bodyOf(calls[0])).toEqual({ name: 'Dash', description: 'watch the agents' });
	});
});

describe('curating a project', () => {
	it('patches only the fields it was given', async () => {
		const project = aProject({ pinned: true });
		const { calls, request } = recorder(jsonReply(200, { project }));

		const patched = await ownerActions(request).patchProject('agent-dashboard', { pinned: true });

		expect(patched).toEqual(project);
		expect(calls[0].url).toBe('/api/projects/agent-dashboard');
		expect(calls[0].init.method).toBe('PATCH');
		expect(bodyOf(calls[0])).toEqual({ pinned: true });
	});

	it('escapes a reference rather than pasting it into the path', async () => {
		const { calls, request } = recorder(jsonReply(200, { project: aProject() }));

		await ownerActions(request).patchProject('a b/c', { pinned: true });

		expect(calls[0].url).toBe('/api/projects/a%20b%2Fc');
	});
});

describe('curating an update', () => {
	it('pins one update', async () => {
		const update = anUpdate({ pinned: true });
		const { calls, request } = recorder(jsonReply(200, { update }));

		expect(await ownerActions(request).setUpdatePinned('u1', true)).toEqual(update);
		expect(calls[0].url).toBe('/api/updates/u1');
		expect(bodyOf(calls[0])).toEqual({ pinned: true });
	});

	it('deletes one update', async () => {
		const update = anUpdate({ deletedAt: 1 });
		const { calls, request } = recorder(jsonReply(200, { update }));

		expect(await ownerActions(request).deleteUpdate('u1')).toEqual(update);
		expect(calls[0].init.method).toBe('DELETE');
		expect(calls[0].init.body).toBeUndefined();
	});
});

describe('when the server refuses', () => {
	it('throws the domain code and message the endpoint sent', async () => {
		const { request } = recorder(
			jsonReply(409, { error: 'conflict', message: 'slug already in use: other' })
		);

		const failure = await ownerActions(request)
			.patchProject('dash', { slug: 'other' })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ActionError);
		expect(failure).toMatchObject({
			code: 'conflict',
			status: 409,
			message: 'slug already in use: other'
		});
	});

	it('still says something useful when the failure carries no JSON', async () => {
		const { request } = recorder(() => new Response('<html>502</html>', { status: 502 }));

		const failure = await ownerActions(request)
			.deleteUpdate('u1')
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ActionError);
		expect((failure as ActionError).status).toBe(502);
		expect((failure as ActionError).message).not.toBe('');
	});

	it('reports a session that has expired as exactly that', async () => {
		const { request } = recorder(jsonReply(401, { error: 'unauthenticated' }));

		const failure = (await ownerActions(request)
			.createProject({ name: 'Dash' })
			.catch((error: unknown) => error)) as ActionError;

		expect(failure.code).toBe('unauthenticated');
		expect(failure.message).toMatch(/sign/i);
	});

	it('turns a network failure into the same error shape', async () => {
		const request = () => Promise.reject(new TypeError('offline'));

		const failure = (await ownerActions(request)
			.createProject({ name: 'Dash' })
			.catch((error: unknown) => error)) as ActionError;

		expect(failure).toBeInstanceOf(ActionError);
		expect(failure.code).toBe('unreachable');
	});
});
