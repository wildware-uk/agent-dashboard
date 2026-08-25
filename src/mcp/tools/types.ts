/**
 * What a tool is, in this codebase.
 *
 * A tool is data, not a registration side effect: `{ name, config, run }`. That
 * is what lets `./index.test.ts` assert over every tool's schema — for instance
 * that **no tool takes an agent identifier** (design §5) — instead of trusting a
 * reviewer to notice one that does.
 *
 * `run` receives its dependencies as an argument, and the agent inside them is
 * the one resolved from the bearer token for this request. A tool therefore has
 * no way to act as anybody else: there is no argument for it, and nothing global
 * to reach for.
 */
import type { Agent, DomainContext } from '$domain';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export type ToolDeps = {
	/** The db, bus and clock this request works through. */
	ctx: DomainContext;
	/** Who is calling, resolved from the bearer token — never from an argument. */
	agent: Agent;
};

/** The zod shape a tool's arguments are described by. */
export type ToolShape = Record<string, z.ZodType>;

/**
 * A tool, ready to hand to `McpServer.registerTool`.
 *
 * `config` is exactly the SDK's tool config, so nothing is translated on the way
 * in: what the tests read is what the agent is told.
 */
export type McpTool<Shape extends ToolShape> = {
	name: string;
	config: {
		title: string;
		/**
		 * The product's real API documentation (design §5): written for an agent,
		 * and stating what every argument accepts.
		 */
		description: string;
		inputSchema: Shape;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	};
	run: (deps: ToolDeps, args: z.output<z.ZodObject<Shape>>) => CallToolResult;
};

/** A tool with its argument type erased, for code that only reads the schema. */
export type AnyMcpTool = {
	name: string;
	config: {
		title: string;
		description: string;
		inputSchema: ToolShape;
		annotations?: McpTool<ToolShape>['config']['annotations'];
	};
};
