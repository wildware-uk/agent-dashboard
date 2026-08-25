/**
 * Public entry point for the MCP server (design §5, §11 step 5).
 *
 * `src/http/routes/mcp/+server.ts` mounts this at `POST /mcp`; nothing else
 * should import it.
 *
 * ```ts
 * import { createMcpHandler } from '$mcp';
 *
 * const mcp = createMcpHandler();
 * export const POST = (event) => mcp(event);
 * ```
 *
 * Everything an agent can do goes through `createMcpHandler`: it authenticates
 * the bearer token, applies the per-token rate limit, and only then builds a
 * server whose tools are already bound to that agent. See ./README.md for the
 * boundary this module keeps, and `./server.ts` for why the server is stateless.
 *
 * `./testing.ts` is a second, test-only entry point and is not re-exported here.
 */
export {
	MCP_INSTRUCTIONS,
	MCP_SERVER_NAME,
	MCP_SERVER_VERSION,
	createMcpHandler,
	createMcpServer,
	type McpHandler,
	type McpHandlerOptions,
	type McpRequestEvent
} from './server';
export {
	BEARER_SCHEME,
	authenticateMcpRequest,
	readBearerToken,
	type BearerFailure,
	type BearerResult,
	type McpAuthInput,
	type McpAuthOutcome,
	type McpAuthRefusal
} from './auth';
export { mcpConfig, type McpConfig } from './env';
export {
	MCP_RATE_LIMIT,
	MCP_RATE_WINDOW_MS,
	createTokenRateLimiter,
	retryAfterSeconds,
	type RateVerdict,
	type TokenRateLimiter
} from './rate-limit';
export { JSONRPC_SERVER_ERROR, misconfiguredResponse, refusalResponse } from './responses';
export {
	TOOLS,
	TOOL_NAMES,
	createProjectTool,
	listProjectsTool,
	postUpdateTool,
	registerTools,
	type AnyMcpTool,
	type McpTool,
	type ToolDeps,
	type ToolShape
} from './tools';
export {
	failed,
	guard,
	ok,
	projectView,
	updateView,
	type ProjectView,
	type UpdateView
} from './results';
