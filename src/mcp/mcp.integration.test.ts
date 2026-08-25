/**
 * The MCP surface, driven by a real SDK client over real HTTP with real auth
 * (design §9).
 *
 * Everything else in this module is tested against functions. This file is the
 * one that catches what functions cannot: a zod shape the SDK cannot turn into
 * JSON Schema, a header the transport insists on, a session guard quietly
 * swallowing `/mcp`, a stateless server that forgets it was initialised. It
 * starts a Node HTTP server, wraps it in the **production** session-guard hook,
 * and talks to it with the SDK's own client.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getRequest, setResponse } from '@sveltejs/kit/node';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listUpdates } from '$domain';
import { createAuthHandle } from '$http/auth';
import { createTokenRateLimiter, type TokenRateLimiter } from './rate-limit';
import { createMcpHandler, MCP_SERVER_NAME } from './server';
import { mcpHarness, type McpHarness } from './testing';

/** A session secret for the guard. No test ever presents a cookie signed by it. */
const SESSION_SECRET = 's'.repeat(32);

let mcp: McpHarness;
let rateLimiter: TokenRateLimiter;
let server: Server;
let base: string;

/**
 * The guard exactly as `src/hooks.server.ts` installs it, in front of two
 * routes: `/mcp`, which it must let through untouched, and `/api/snapshot`,
 * which it must refuse without a cookie. The second is what makes the first
 * meaningful — a guard that was accidentally inert would pass either way.
 */
const guard: Handle = createAuthHandle({
	config: () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$stub' })
});

beforeAll(async () => {
	const mcpHandler = createMcpHandler({
		context: () => mcp.h,
		config: () => ({ tokenSecret: mcp.secret }),
		// One limiter for the lifetime of the server, replaced per test.
		rateLimiter: { take: (key) => rateLimiter.take(key), reset: () => {}, size: () => 0 }
	});

	server = createServer(async (req, res) => {
		const request = await getRequest({ request: req, base });
		const url = new URL(request.url);

		// SvelteKit answers a route that exists but has no handler for the method
		// with 405, which is what the MCP client reads as "no server push".
		if (url.pathname === '/mcp' && request.method !== 'POST') {
			await setResponse(res, new Response(null, { status: 405, headers: { allow: 'POST' } }));
			return;
		}

		const event = {
			request,
			url,
			route: { id: url.pathname },
			cookies: { get: () => undefined }
		} as unknown as RequestEvent;

		const response = await guard({
			event,
			resolve: (resolved) =>
				resolved.url.pathname === '/mcp'
					? mcpHandler({ request: resolved.request })
					: new Response('snapshot', { status: 200 })
		});

		await setResponse(res, response);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
});

beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	rateLimiter = createTokenRateLimiter();
});

/** A connected SDK client, authenticated the way an agent's config would be. */
async function connect(token: string | null = mcp.token): Promise<Client> {
	const client = new Client({ name: 'integration-test', version: '1.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
		requestInit: token === null ? {} : { headers: { authorization: `Bearer ${token}` } }
	});
	await client.connect(transport);
	return client;
}

/** The `structuredContent` of a tool call, which is where the ids are. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args });
	return result as { isError?: boolean; structuredContent?: Record<string, unknown> };
}

describe('the transport', () => {
	it('completes the handshake and reports who it is', async () => {
		const client = await connect();

		expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME });
		expect(client.getInstructions()).toContain('Agent Dashboard');

		await client.close();
	});

	it('serves a bearer-token request that carries no session cookie at all', async () => {
		// The point of the whole slice: `/mcp` is exempt from the owner's session
		// guard, and the guard in front of this server is the production one.
		const client = await connect();

		await expect(client.listTools()).resolves.toBeTruthy();
		await client.close();

		// And the guard really is awake: a route it does protect is refused.
		const guarded = await fetch(`${base}/api/snapshot`);
		expect(guarded.status).toBe(401);
	});

	it('publishes its tools with the descriptions an agent has to read', async () => {
		const client = await connect();
		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'create_project',
			'list_projects',
			'post_update'
		]);

		const post = tools.find((tool) => tool.name === 'post_update')!;
		expect(post.description).toContain('slug');
		expect(post.description).toContain('token');
		// Descriptions survive the trip through JSON Schema, which is the half of
		// the documentation a client can render next to each field.
		const properties = post.inputSchema.properties as Record<string, { description?: string }>;
		expect(Object.keys(properties).sort()).toEqual(['body', 'level', 'project', 'title']);
		for (const [name, schema] of Object.entries(properties)) {
			expect(schema.description, name).toBeTruthy();
		}
		expect(post.inputSchema.required).toEqual(['project', 'body']);

		await client.close();
	});

	it('answers a GET with 405 rather than pretending to offer a push stream', async () => {
		const response = await fetch(`${base}/mcp`, {
			headers: { authorization: `Bearer ${mcp.token}` }
		});

		expect(response.status).toBe(405);
	});
});

describe('the tools, end to end', () => {
	it('creates a project, idempotently, and the row is really there', async () => {
		const client = await connect();

		const created = await call(client, 'create_project', {
			name: 'Agent Dashboard',
			description: 'the status wall'
		});
		expect(created.structuredContent).toMatchObject({
			created: true,
			project: { slug: 'agent-dashboard' }
		});

		const again = await call(client, 'create_project', { name: 'Agent Dashboard' });
		expect(again.structuredContent).toMatchObject({ created: false });

		const listed = await call(client, 'list_projects', {});
		expect(listed.structuredContent).toMatchObject({ count: 1 });

		expect(mcp.h.eventNames()).toEqual(['project.created']);
		await client.close();
	});

	it('posts an update: the row lands, and update.created is published', async () => {
		const client = await connect();
		await call(client, 'create_project', { name: 'Agent Dashboard' });
		mcp.h.events.length = 0;

		const posted = await call(client, 'post_update', {
			project: 'agent-dashboard',
			title: 'shipped',
			body: '# it works\n\nOver MCP, over HTTP, with a real token.',
			level: 'success'
		});

		expect(posted.isError).toBeUndefined();
		expect(posted.structuredContent).toMatchObject({
			update: { agent_id: mcp.deps.agent.id, level: 'success', title: 'shipped' }
		});

		const { updates } = listUpdates(mcp.h, { project: 'agent-dashboard' });
		expect(updates).toHaveLength(1);
		expect(updates[0].body).toContain('it works');
		expect(mcp.h.events).toHaveLength(1);
		expect(mcp.h.events[0]).toMatchObject({
			type: 'update.created',
			payload: { updateId: updates[0].id, agentId: mcp.deps.agent.id }
		});

		await client.close();
	});

	it('attributes the update to the token holder, whatever the arguments say', async () => {
		const impostor = mcp.mint('impostor');
		const client = await connect();
		await call(client, 'create_project', { name: 'Feed' });

		// There is no `agent_id` argument, so the SDK drops it. The update must
		// still be attributed to the token that sent it (design §5).
		await call(client, 'post_update', {
			project: 'feed',
			body: 'posted by the token holder',
			agent_id: impostor.agentId
		});

		const { updates } = listUpdates(mcp.h, { project: 'feed' });
		expect(updates[0].agentId).toBe(mcp.deps.agent.id);
		expect(updates[0].agentId).not.toBe(impostor.agentId);

		await client.close();
	});

	it('keeps two agents apart: each posts as itself over its own token', async () => {
		const second = mcp.mint('second-agent');
		const first = await connect();
		const other = await connect(second.token);

		await call(first, 'create_project', { name: 'Shared' });
		await call(first, 'post_update', { project: 'shared', body: 'from the first' });
		await call(other, 'post_update', { project: 'shared', body: 'from the second' });

		const { updates } = listUpdates(mcp.h, { project: 'shared' });
		expect(updates.map((update) => [update.body, update.agentId === second.agentId])).toEqual([
			['from the second', true],
			['from the first', false]
		]);

		await first.close();
		await other.close();
	});

	it('reports a domain refusal as a tool error the agent can act on', async () => {
		const client = await connect();

		const result = await call(client, 'post_update', { project: 'nope', body: 'hello' });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'not_found' });
		await client.close();
	});

	it('rejects arguments that do not match the schema before any handler runs', async () => {
		const client = await connect();

		const result = await call(client, 'post_update', { body: 42 });

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/expected string.*project/s);
		expect(mcp.h.eventNames()).toEqual([]);

		await client.close();
	});
});

/**
 * The refusal an SDK client saw: the HTTP status it carries, plus the message
 * body the server sent, which is what an agent's author ends up reading.
 */
async function refused(attempt: Promise<unknown>): Promise<{ status?: number; message: string }> {
	const error = await attempt.then(
		() => undefined,
		(thrown: unknown) => thrown as { code?: number; message: string }
	);

	expect(error, 'expected the request to be refused').toBeDefined();
	return { status: error!.code, message: error!.message };
}

describe('auth over the wire', () => {
	it('refuses a client with no token at all', async () => {
		const { status, message } = await refused(connect(null));

		expect(status).toBe(401);
		expect(message).toContain('missing_token');
	});

	it('refuses a malformed token', async () => {
		const { status, message } = await refused(connect('not-a-real-token'));

		expect(status).toBe(401);
		expect(message).toContain('malformed_token');
	});

	it('refuses an unknown token', async () => {
		const { status, message } = await refused(connect('Q'.repeat(43)));

		expect(status).toBe(401);
		expect(message).toContain('unknown_token');
	});

	it('refuses a revoked token, and refuses it mid-session too', async () => {
		const client = await connect();
		await call(client, 'create_project', { name: 'Before' });

		mcp.h.db.prepare('UPDATE agents SET revoked_at = 1 WHERE id = ?').run(mcp.deps.agent.id);

		// Stateless auth means revocation bites on the very next call, with no
		// session to outlive it.
		const midSession = await refused(client.callTool({ name: 'list_projects', arguments: {} }));
		expect(midSession).toMatchObject({ status: 401 });
		expect(midSession.message).toContain('revoked_token');
		await client.close();

		expect(await refused(connect())).toMatchObject({ status: 401 });
	});

	it('rate limits per token and says when to come back', async () => {
		// The handshake costs two requests of its own: the `initialize` call and the
		// `notifications/initialized` that follows it. The GET the client then tries
		// is answered 405 by the route before it reaches the limiter.
		rateLimiter = createTokenRateLimiter({ limit: 2, windowMs: 60_000 });
		const client = await connect();

		const limited = await refused(client.callTool({ name: 'list_projects', arguments: {} }));
		expect(limited.status).toBe(429);
		expect(limited.message).toContain('rate_limited');

		const raw = await fetch(`${base}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${mcp.token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		});
		expect(raw.status).toBe(429);
		expect(Number(raw.headers.get('retry-after'))).toBeGreaterThan(0);

		await client.close();
	});

	it('records that the agent was heard from', async () => {
		const client = await connect();

		expect(
			mcp.h.db.prepare('SELECT last_seen_at FROM agents WHERE id = ?').get(mcp.deps.agent.id)
		).toMatchObject({ last_seen_at: expect.any(Number) });

		await client.close();
	});
});
