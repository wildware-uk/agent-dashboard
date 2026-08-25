/**
 * `POST /mcp` — the agent-facing front door (design §5).
 *
 * Agents authenticate with `Authorization: Bearer <agent token>` and never with
 * the owner's session cookie: this path is exempt from the session guard by name
 * in `src/http/auth/guard.ts`, and `$mcp` does its own auth instead. That
 * exemption is load-bearing in both directions — a guard that crept over `/mcp`
 * would break every agent while looking like it was working, and an `/mcp` that
 * forgot to check tokens would be wide open — so both halves are tested:
 * `src/http/auth/guard.test.ts` for the exemption, `src/mcp/mcp.integration.test.ts`
 * for a real bearer-token request that carries no cookie at all.
 *
 * `POST` is the whole surface. `GET /mcp` therefore answers 405, which the MCP
 * spec allows and the SDK client reads as "this server does not push
 * server-initiated messages"; `src/mcp/server.ts` explains why it does not need
 * to. Everything else — the transport, the tool set, the rate limit — lives in
 * `$mcp`, so this file stays a mount point.
 */
import { createMcpHandler } from '$mcp';
import type { RequestHandler } from './$types';

const mcp = createMcpHandler();

export const POST: RequestHandler = (event) => mcp(event);
