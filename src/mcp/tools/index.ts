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
import { attachMediaTool } from './attach-media';
import { awaitRequestTool } from './await-request';
import { claimTaskTool } from './claim-task';
import { completeTaskTool } from './complete-task';
import { createProjectTool } from './create-project';
import { createTaskTool } from './create-task';
import { createUploadTool } from './create-upload';
import { editUpdateTool } from './edit-update';
import { endSessionTool } from './end-session';
import { getMessagesTool } from './get-messages';
import { acknowledgeTool } from './acknowledge';
import { deleteMessageTool } from './delete-message';
import { postMessageTool } from './post-message';
import { heartbeatTool } from './heartbeat';
import { listProjectsTool } from './list-projects';
import { listTasksTool } from './list-tasks';
import { postUpdateTool } from './post-update';
import { registerSessionTool } from './register-session';
import { requestInputTool } from './request-input';
import { setProjectThemeTool } from './set-project-theme';
import type { AnyMcpTool, ToolDeps } from './types';

export { attachMediaTool } from './attach-media';
export { awaitRequestTool } from './await-request';
export { claimTaskTool } from './claim-task';
export { completeTaskTool } from './complete-task';
export { createProjectTool } from './create-project';
export { createTaskTool } from './create-task';
export { createUploadTool } from './create-upload';
export { editUpdateTool } from './edit-update';
export { endSessionTool } from './end-session';
export { getMessagesTool } from './get-messages';
export { acknowledgeTool } from './acknowledge';
export { deleteMessageTool } from './delete-message';
export { postMessageTool } from './post-message';
export { heartbeatTool } from './heartbeat';
export { listProjectsTool } from './list-projects';
export { listTasksTool } from './list-tasks';
export { postUpdateTool } from './post-update';
export { registerSessionTool } from './register-session';
export { requestInputTool } from './request-input';
export { setProjectThemeTool } from './set-project-theme';
export type { AnyMcpTool, McpTool, ToolDeps, ToolShape } from './types';

/** Every tool this server offers, in the order design §5 lists them. */
export const TOOLS: readonly AnyMcpTool[] = [
	createProjectTool,
	listProjectsTool,
	setProjectThemeTool,
	postUpdateTool,
	editUpdateTool,
	createUploadTool,
	attachMediaTool,
	registerSessionTool,
	heartbeatTool,
	endSessionTool,
	listTasksTool,
	createTaskTool,
	claimTaskTool,
	completeTaskTool,
	getMessagesTool,
	postMessageTool,
	deleteMessageTool,
	acknowledgeTool,
	requestInputTool,
	awaitRequestTool
];

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
	server.registerTool(setProjectThemeTool.name, setProjectThemeTool.config, (args) =>
		setProjectThemeTool.run(deps, args)
	);
	server.registerTool(postUpdateTool.name, postUpdateTool.config, (args) =>
		postUpdateTool.run(deps, args)
	);
	server.registerTool(editUpdateTool.name, editUpdateTool.config, (args) =>
		editUpdateTool.run(deps, args)
	);
	server.registerTool(createUploadTool.name, createUploadTool.config, (args) =>
		createUploadTool.run(deps, args)
	);
	server.registerTool(attachMediaTool.name, attachMediaTool.config, (args) =>
		attachMediaTool.run(deps, args)
	);
	server.registerTool(registerSessionTool.name, registerSessionTool.config, (args) =>
		registerSessionTool.run(deps, args)
	);
	server.registerTool(heartbeatTool.name, heartbeatTool.config, (args) =>
		heartbeatTool.run(deps, args)
	);
	server.registerTool(endSessionTool.name, endSessionTool.config, (args) =>
		endSessionTool.run(deps, args)
	);
	server.registerTool(listTasksTool.name, listTasksTool.config, (args) =>
		listTasksTool.run(deps, args)
	);
	server.registerTool(createTaskTool.name, createTaskTool.config, (args) =>
		createTaskTool.run(deps, args)
	);
	server.registerTool(claimTaskTool.name, claimTaskTool.config, (args) =>
		claimTaskTool.run(deps, args)
	);
	server.registerTool(completeTaskTool.name, completeTaskTool.config, (args) =>
		completeTaskTool.run(deps, args)
	);
	server.registerTool(getMessagesTool.name, getMessagesTool.config, (args) =>
		getMessagesTool.run(deps, args)
	);
	server.registerTool(acknowledgeTool.name, acknowledgeTool.config, (args) =>
		acknowledgeTool.run(deps, args)
	);
	server.registerTool(postMessageTool.name, postMessageTool.config, (args) =>
		postMessageTool.run(deps, args)
	);
	server.registerTool(deleteMessageTool.name, deleteMessageTool.config, (args) =>
		deleteMessageTool.run(deps, args)
	);
	server.registerTool(requestInputTool.name, requestInputTool.config, (args) =>
		requestInputTool.run(deps, args)
	);
	server.registerTool(awaitRequestTool.name, awaitRequestTool.config, (args) =>
		awaitRequestTool.run(deps, args)
	);
}
