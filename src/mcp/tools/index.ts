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
import { createProjectTool } from './create-project';
import { createUploadTool } from './create-upload';
import { editMessageTool } from './edit-message';
import { setStatusTool } from './set-status';
import { listWorkTool } from './list-work';
import { listTagsTool, tagCardTool } from './tag-card';
import { getCardFieldsTool, setCardFieldTool } from './card-fields';
import { editRequestTool } from './edit-request';
import { editUpdateTool } from './edit-update';
import { endSessionTool } from './end-session';
import { getMessagesTool } from './get-messages';
import { acknowledgeTool } from './acknowledge';
import { deleteMessageTool } from './delete-message';
import { postMessageTool } from './post-message';
import { reactTool } from './react';
import { heartbeatTool } from './heartbeat';
import { listEmbedTypesTool } from './list-embed-types';
import { listProjectsTool } from './list-projects';
import { postUpdateTool } from './post-update';
import { registerEmbedTypeTool } from './register-embed-type';
import { listAppsTool } from './list-apps';
import { registerAppTool } from './register-app';
import { setAppDataTool } from './set-app-data';
import { registerSessionTool } from './register-session';
import { requestInputTool } from './request-input';
import { withdrawRequestTool } from './withdraw-request';
import { setProjectThemeTool } from './set-project-theme';
import type { AnyMcpTool, ToolDeps } from './types';

export { attachMediaTool } from './attach-media';
export { awaitRequestTool } from './await-request';
export { createProjectTool } from './create-project';
export { createUploadTool } from './create-upload';
export { editMessageTool } from './edit-message';
export { setStatusTool } from './set-status';
export { listWorkTool } from './list-work';
export { listTagsTool, tagCardTool } from './tag-card';
export { getCardFieldsTool, setCardFieldTool } from './card-fields';
export { editRequestTool } from './edit-request';
export { editUpdateTool } from './edit-update';
export { endSessionTool } from './end-session';
export { getMessagesTool } from './get-messages';
export { acknowledgeTool } from './acknowledge';
export { deleteMessageTool } from './delete-message';
export { postMessageTool } from './post-message';
export { reactTool } from './react';
export { heartbeatTool } from './heartbeat';
export { listEmbedTypesTool, placeholdersIn } from './list-embed-types';
export { listProjectsTool } from './list-projects';
export { postUpdateTool } from './post-update';
export { registerEmbedTypeTool } from './register-embed-type';
export { listAppsTool } from './list-apps';
export { registerAppTool } from './register-app';
export { setAppDataTool } from './set-app-data';
export { registerSessionTool } from './register-session';
export { requestInputTool } from './request-input';
export { withdrawRequestTool } from './withdraw-request';
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
	listEmbedTypesTool,
	registerEmbedTypeTool,
	listAppsTool,
	registerAppTool,
	setAppDataTool,
	registerSessionTool,
	heartbeatTool,
	endSessionTool,
	getMessagesTool,
	postMessageTool,
	editMessageTool,
	setStatusTool,
	listWorkTool,
	listTagsTool,
	tagCardTool,
	getCardFieldsTool,
	setCardFieldTool,
	deleteMessageTool,
	reactTool,
	acknowledgeTool,
	requestInputTool,
	awaitRequestTool,
	editRequestTool,
	withdrawRequestTool
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
	server.registerTool(listEmbedTypesTool.name, listEmbedTypesTool.config, (args) =>
		listEmbedTypesTool.run(deps, args)
	);
	server.registerTool(registerEmbedTypeTool.name, registerEmbedTypeTool.config, (args) =>
		registerEmbedTypeTool.run(deps, args)
	);
	server.registerTool(listAppsTool.name, listAppsTool.config, (args) =>
		listAppsTool.run(deps, args)
	);
	server.registerTool(registerAppTool.name, registerAppTool.config, (args) =>
		registerAppTool.run(deps, args)
	);
	server.registerTool(setAppDataTool.name, setAppDataTool.config, (args) =>
		setAppDataTool.run(deps, args)
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
	server.registerTool(setStatusTool.name, setStatusTool.config, (args) =>
		setStatusTool.run(deps, args)
	);
	server.registerTool(listWorkTool.name, listWorkTool.config, (args) =>
		listWorkTool.run(deps, args)
	);
	server.registerTool(listTagsTool.name, listTagsTool.config, (args) =>
		listTagsTool.run(deps, args)
	);
	server.registerTool(tagCardTool.name, tagCardTool.config, (args) => tagCardTool.run(deps, args));
	server.registerTool(setCardFieldTool.name, setCardFieldTool.config, (args) =>
		setCardFieldTool.run(deps, args)
	);
	server.registerTool(getCardFieldsTool.name, getCardFieldsTool.config, (args) =>
		getCardFieldsTool.run(deps, args)
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
	server.registerTool(editMessageTool.name, editMessageTool.config, (args) =>
		editMessageTool.run(deps, args)
	);
	server.registerTool(deleteMessageTool.name, deleteMessageTool.config, (args) =>
		deleteMessageTool.run(deps, args)
	);
	server.registerTool(reactTool.name, reactTool.config, (args) => reactTool.run(deps, args));
	server.registerTool(requestInputTool.name, requestInputTool.config, (args) =>
		requestInputTool.run(deps, args)
	);
	server.registerTool(awaitRequestTool.name, awaitRequestTool.config, (args) =>
		awaitRequestTool.run(deps, args)
	);
	server.registerTool(editRequestTool.name, editRequestTool.config, (args) =>
		editRequestTool.run(deps, args)
	);
	server.registerTool(withdrawRequestTool.name, withdrawRequestTool.config, (args) =>
		withdrawRequestTool.run(deps, args)
	);
}
