/**
 * The MCP Streamable HTTP server (design §5, §11 step 5).
 *
 * ## Why a fresh server per request
 *
 * The transport runs **stateless**: no `Mcp-Session-Id`, one `McpServer` and one
 * transport per HTTP request, both closed when the response is built. Two things
 * fall out of that, and they are the reason for the choice:
 *
 * - **The calling agent is a constructor argument, not a lookup.** Tools are
 *   registered already bound to the agent the bearer token resolved to, so there
 *   is no request-scoped identity to thread through handlers and no way for a
 *   handler to read anybody else's. Design §5's "one agent cannot post as
 *   another" is enforced by construction, not by discipline.
 * - **Nothing survives a request**, so a restart, a crash mid-call, or two
 *   clients sharing a token cannot leave state behind that the next request
 *   trips over.
 *
 * The cost is that server-initiated messages — the standalone `GET /mcp` SSE
 * stream — are not offered; the route answers `GET` with 405, which the SDK
 * client treats as "this server does not push", exactly as the spec allows. The
 * approval gate (§5) is a bounded long-poll for precisely this reason, so
 * nothing in the design needs the push channel.
 *
 * ## Order of business
 *
 * `createMcpHandler` refuses in this order, and never gets further than the
 * first failure: configured → bearer present → token shaped → rate limit →
 * identity → tools. Auth policy lives in `./auth.ts`, the refusal wording in
 * `./responses.ts`, and the tools in `./tools/`. This file is the wiring.
 */
import { context, type DomainContext } from '$domain';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateMcpRequest } from './auth';
import { mcpConfig, type McpConfig } from './env';
import { createTokenRateLimiter, type TokenRateLimiter } from './rate-limit';
import { misconfiguredResponse, refusalResponse } from './responses';
import { TOOL_NAMES, registerTools, type ToolDeps } from './tools';

/** How the server introduces itself in the `initialize` handshake. */
export const MCP_SERVER_NAME = 'agent-dashboard';

/**
 * Protocol-facing version of the tool surface.
 *
 * Deliberately not the package version: this is what a client caches its tool
 * list against, and it should change when the tools change, not when the CSS
 * does.
 */
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * The `instructions` every client receives with the handshake.
 *
 * Clients show this to their model once, ahead of the tool list, so it is the
 * cheapest place to say the things that are true of every tool.
 */
export const MCP_INSTRUCTIONS = [
	'This is an Agent Dashboard: a status wall a human owner watches live while you work.',
	'',
	'Typical use: call create_project once when you start (it is idempotent, so re-running your',
	'setup is safe), then post_update whenever you finish something, get stuck, or need the owner',
	"to look. Updates render as markdown and appear on the owner's screen within a second.",
	'',
	'Also call register_session when your run begins and heartbeat on the interval it gives you:',
	'that is what shows you as online, and each heartbeat tells you whether any messages, tasks or',
	'approvals are waiting, so you never have to poll for work. Call end_session when you finish.',
	'',
	'You are identified by your bearer token. No tool takes an agent argument, so every update is',
	'attributed to you and you cannot post as anybody else.',
	'',
	'Failures come back as tool errors with a code: "not_found" (the project reference matched',
	'nothing — call list_projects), "invalid_argument" (an argument was empty or too long),',
	'"conflict" (the current state refuses it). HTTP 401 means your token is missing, malformed or',
	'revoked; HTTP 429 means you are posting faster than the per-token rate limit and should honour',
	'the Retry-After header.'
].join('\n');

/** A server with this request's agent already bound into every tool. */
export function createMcpServer(deps: ToolDeps): McpServer {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
		{ capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
	);
	registerTools(server, deps);
	return server;
}

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type McpRequestEvent = { request: Request };

export type McpHandler = (event: McpRequestEvent) => Promise<Response>;

export type McpHandlerOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Auth secret, injectable so tests need no environment. */
	config?: () => McpConfig | null;
	/** Defaults to the per-token limits in `./rate-limit.ts`. */
	rateLimiter?: TokenRateLimiter;
};

/** Build the `POST /mcp` handler. */
export function createMcpHandler(options: McpHandlerOptions = {}): McpHandler {
	const {
		context: getContext = context,
		config = mcpConfig,
		rateLimiter = createTokenRateLimiter()
	} = options;

	return async ({ request }) => {
		const secrets = config();
		if (!secrets) return misconfiguredResponse();

		const ctx = getContext();
		const auth = authenticateMcpRequest({
			request,
			ctx,
			secret: secrets.tokenSecret,
			rateLimiter
		});
		if (!auth.ok) return refusalResponse(auth);

		return serve(request, { ctx, agent: auth.agent });
	};
}

/** Run one JSON-RPC exchange on a server that exists only for this request. */
async function serve(request: Request, deps: ToolDeps): Promise<Response> {
	const server = createMcpServer(deps);
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: no session id, so nothing has to be remembered between
		// requests and no session map can leak.
		sessionIdGenerator: undefined,
		// One complete JSON response per request rather than an SSE stream. Every
		// tool here answers immediately, and a stream would only add a frame the
		// client has to reassemble.
		enableJsonResponse: true
	});

	try {
		await server.connect(transport);
		return await transport.handleRequest(request);
	} finally {
		// Closes the transport too. The response body is a finished string by the
		// time `handleRequest` resolves, so there is nothing left to write.
		await server.close();
	}
}

/** The tool names this server offers. Re-exported so a README can quote them. */
export { TOOL_NAMES };
