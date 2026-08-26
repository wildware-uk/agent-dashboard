/**
 * Test support for the MCP adapter (design §9).
 *
 * A second, test-only entry point — deliberately not re-exported from
 * `./index.ts`, exactly as `$domain/testing` is not re-exported from `$domain`,
 * so nothing in a production path can reach an in-memory database.
 *
 * What every MCP test needs is the same triple: a domain harness, an agent with
 * a real minted token, and the `ToolDeps` a tool is called with.
 */
import { mintAgentToken } from '$domain';
import { harness, type Harness } from '$domain/testing';
import type { Clock } from '$domain';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDeps } from './tools/types';

/** Long enough to satisfy `loadConfig`'s minimum for `TOKEN_SECRET`. */
export const TEST_TOKEN_SECRET = 'test-token-secret-'.padEnd(40, 'x');

export type McpHarness = {
	/** The domain harness: `db`, `bus`, `now`, plus the recorded events. */
	h: Harness;
	/** What a tool is called with. */
	deps: ToolDeps;
	/** The agent's bearer token, in clear, as only a mint ever sees it. */
	token: string;
	secret: string;
	/** Mint another agent, e.g. to prove one cannot post as the other. */
	mint(name: string): { agentId: string; token: string };
};

export function mcpHarness(
	options: { name?: string; secret?: string; now?: Clock; holdMs?: number } = {}
): McpHarness {
	const h = harness({ now: options.now });
	const secret = options.secret ?? TEST_TOKEN_SECRET;
	const { agent, token } = mintAgentToken(h, { name: options.name ?? 'test-agent', secret });

	return {
		h,
		// `holdMs` is only read by `request_input` and `await_request`; a test that
		// exercises the wait passes a hold measured in milliseconds so it does not
		// sit out the real 55 seconds (design §5).
		deps: { ctx: h, agent, holdMs: options.holdMs },
		token,
		secret,
		mint(name) {
			const minted = mintAgentToken(h, { name, secret });
			return { agentId: minted.agent.id, token: minted.token };
		}
	};
}

/**
 * The text of a tool result's first content block.
 *
 * `content` is a union of every block type the protocol allows, so reading
 * `.text` off it needs a narrowing every assertion would otherwise repeat.
 */
export function toolText(result: CallToolResult): string {
	const [block] = result.content;
	return block?.type === 'text' ? block.text : '';
}
