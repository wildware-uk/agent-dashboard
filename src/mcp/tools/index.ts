/**
 * The tool set, as data, plus the one place it is registered.
 *
 * `TOOLS` exists so the invariants in `./index.test.ts` can be asserted over
 * every tool at once — no agent identifier as an argument (design §5), a
 * description that documents each argument — rather than tool by tool as new
 * ones land.
 *
 * `registerTools` is written out one call per tool on purpose: the SDK infers a
 * tool's argument type from its own `inputSchema`, so each handler is checked
 * against its own schema at compile time. A clever loop would erase exactly the
 * type that matters here.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createProjectTool } from './create-project';
import { listProjectsTool } from './list-projects';
import { postUpdateTool } from './post-update';
import type { AnyMcpTool, ToolDeps } from './types';

export { createProjectTool } from './create-project';
export { listProjectsTool } from './list-projects';
export { postUpdateTool } from './post-update';
export type { AnyMcpTool, McpTool, ToolDeps, ToolShape } from './types';

/** Every tool this server offers, in the order design §5 lists them. */
export const TOOLS: readonly AnyMcpTool[] = [createProjectTool, listProjectsTool, postUpdateTool];

/** Just the names, for tests and for a README that cannot drift. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** Register every tool on a server, bound to one request's agent and context. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
	server.registerTool(createProjectTool.name, createProjectTool.config, (args) =>
		createProjectTool.run(deps, args)
	);
	server.registerTool(listProjectsTool.name, listProjectsTool.config, (args) =>
		listProjectsTool.run(deps, args)
	);
	server.registerTool(postUpdateTool.name, postUpdateTool.config, (args) =>
		postUpdateTool.run(deps, args)
	);
}
