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
import type { Agent, DomainContext, MediaSettings } from '$domain';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export type ToolDeps = {
	/** The db, bus and clock this request works through. */
	ctx: DomainContext;
	/** Who is calling, resolved from the bearer token — never from an argument. */
	agent: Agent;
	/**
	 * How long an owner request may park before answering `pending` (design §5).
	 *
	 * Resolved from `HOLD_S` once, where the rest of the environment is read, so
	 * no tool reaches for `process.env` on the request path — and a test can hand
	 * over a hold measured in milliseconds instead of waiting out a real one.
	 */
	holdMs?: number;
	/**
	 * Where the media lives, for the tools that hand an agent a picture.
	 *
	 * `get_messages` inlines the images attached to a message, because an agent
	 * cannot fetch them: `/media/...` wants the owner's session (design §8). The
	 * settings are resolved once with the rest of the environment rather than
	 * read per request, and a test hands over a directory of its own.
	 */
	media?: MediaSettings;
};

/** The zod shape a tool's arguments are described by. */
export type ToolShape = Record<string, z.ZodType>;

/**
 * A tool, ready to hand to `McpServer.registerTool`.
 *
 * `config` is exactly the SDK's tool config, so nothing is translated on the way
 * in: what the tests read is what the agent is told.
 */
export type McpTool<
	Shape extends ToolShape,
	/**
	 * What `run` hands back.
	 *
	 * A tool answers synchronously unless it genuinely waits: `request_input` and
	 * `await_request` park on the event bus until the owner answers or the hold
	 * elapses (design §5), so they declare `Promise<CallToolResult>` and every
	 * other tool stays exactly as immediate as it reads.
	 */
	Result extends CallToolResult | Promise<CallToolResult> = CallToolResult
> = {
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
	run: (deps: ToolDeps, args: z.output<z.ZodObject<Shape>>) => Result;
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
