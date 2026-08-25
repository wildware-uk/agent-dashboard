import { beforeEach, describe, expect, it } from 'vitest';
import { createMcpHandler, MCP_SERVER_NAME } from './server';
import { createTokenRateLimiter } from './rate-limit';
import { mcpHarness, type McpHarness } from './testing';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness();
});

/** A JSON-RPC POST, the way a client would send it. */
function post(
	body: unknown,
	options: { token?: string | null; handler?: ReturnType<typeof createMcpHandler> } = {}
) {
	const headers = new Headers({
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream'
	});
	if (options.token !== null) headers.set('authorization', `Bearer ${options.token ?? mcp.token}`);

	const handler = options.handler ?? createMcpHandler(handlerOptions());
	return handler({
		request: new Request('http://dash.test/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		})
	});
}

function handlerOptions(rateLimiter = createTokenRateLimiter()) {
	return {
		context: () => mcp.h,
		config: () => ({ tokenSecret: mcp.secret }),
		rateLimiter
	};
}

const initialize = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'test', version: '1' }
	}
};

describe('createMcpHandler refusals', () => {
	it('refuses a request with no Authorization header with 401 and a bearer challenge', async () => {
		const response = await post(initialize, { token: null });

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		await expect(response.json()).resolves.toMatchObject({
			jsonrpc: '2.0',
			error: { data: { error: 'missing_token' } }
		});
	});

	it('refuses a malformed token, and says invalid_token in the challenge', async () => {
		const response = await post(initialize, { token: 'not-a-token' });

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
		await expect(response.json()).resolves.toMatchObject({
			error: { data: { error: 'malformed_token' } }
		});
	});

	it('refuses an unknown token', async () => {
		const response = await post(initialize, { token: 'Z'.repeat(43) });

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error: { data: { error: 'unknown_token' } }
		});
	});

	it('refuses a revoked token and says so', async () => {
		const other = mcp.mint('retired');
		mcp.h.db.prepare('UPDATE agents SET revoked_at = 1 WHERE name = ?').run('retired');

		const response = await post(initialize, { token: other.token });

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error: { data: { error: 'revoked_token' } }
		});
	});

	it('never lets what the client sent break the challenge it is quoted into', async () => {
		// The challenge quotes the scheme back, so a quote in it must not end the
		// quoted-string early and turn the rest into auth-params of its own.
		const response = await createMcpHandler(handlerOptions())({
			request: new Request('http://dash.test/mcp', {
				method: 'POST',
				headers: { authorization: 'Ba"d, realm="elsewhere" zzz' }
			})
		});

		expect(response.status).toBe(401);
		const challenge = response.headers.get('www-authenticate') ?? '';
		expect(challenge).toMatch(/^Bearer error="invalid_token", error_description="[^"]*"$/);
		expect(challenge).not.toContain('elsewhere"');
	});

	it('rate limits per token with a Retry-After the client can obey', async () => {
		const handler = createMcpHandler(handlerOptions(createTokenRateLimiter({ limit: 1 })));

		expect((await post(initialize, { handler })).status).toBe(200);

		const limited = await post(initialize, { handler });
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		await expect(limited.json()).resolves.toMatchObject({
			error: { data: { error: 'rate_limited' } }
		});
	});

	it('fails closed with 503 when TOKEN_SECRET is not configured', async () => {
		const handler = createMcpHandler({ context: () => mcp.h, config: () => null });

		const response = await handler({
			request: new Request('http://dash.test/mcp', { method: 'POST' })
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { data: { error: 'server_not_configured' } }
		});
	});
});

describe('createMcpHandler transport', () => {
	it('answers initialize with the server identity and a tools capability', async () => {
		const response = await post(initialize);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		await expect(response.json()).resolves.toMatchObject({
			jsonrpc: '2.0',
			id: 1,
			result: {
				serverInfo: { name: MCP_SERVER_NAME },
				capabilities: { tools: {} }
			}
		});
	});

	it('runs a tool call and writes through to the domain', async () => {
		const response = await post({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'create_project', arguments: { name: 'From MCP' } }
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { structuredContent: unknown } };
		expect(body.result.structuredContent).toMatchObject({
			created: true,
			project: { slug: 'from-mcp' }
		});
		expect(mcp.h.eventNames()).toEqual(['project.created']);
	});

	it('rejects a body that is not JSON without reaching a tool', async () => {
		const handler = createMcpHandler(handlerOptions());
		const response = await handler({
			request: new Request('http://dash.test/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${mcp.token}`
				},
				body: 'not json'
			})
		});

		expect(response.status).toBe(400);
	});
});
