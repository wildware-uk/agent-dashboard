/**
 * The HTTP answers `/mcp` gives when a request never reaches a tool.
 *
 * These are the only responses this module builds itself; everything else comes
 * out of the SDK transport. They are JSON-RPC error envelopes rather than bare
 * text, because the caller is an MCP client: a client that gets a JSON-RPC error
 * body can surface `error.message` to its agent, and `error.data.error` is a
 * stable string it can branch on.
 *
 * The status codes matter as much as the bodies. 401 with a `WWW-Authenticate`
 * challenge is what tells a client the problem is its credentials and not its
 * request; 429 with `Retry-After` is what makes a rate limit something a client
 * can obey rather than hammer.
 */
import { retryAfterSeconds } from './rate-limit';
import type { McpAuthRefusal } from './auth';

/** JSON-RPC's "implementation-defined server error" band, as the SDK uses it. */
export const JSONRPC_SERVER_ERROR = -32000;

function jsonRpcError(
	status: number,
	message: string,
	error: string,
	headers: Record<string, string> = {}
): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			id: null,
			error: { code: JSONRPC_SERVER_ERROR, message, data: { error } }
		}),
		{
			status,
			headers: { 'content-type': 'application/json', ...headers }
		}
	);
}

/**
 * A header value safe to put in a quoted-string.
 *
 * The description quotes back part of what the client sent (its auth scheme), so
 * it has to be sanitised: an unescaped quote or a newline in a response header is
 * a header-injection bug, not a formatting one.
 */
function quotable(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, ' ').replace(/["\\]/g, '');
}

/**
 * The `WWW-Authenticate` challenge for a 401.
 *
 * RFC 6750: a request that carried no credentials at all gets the bare scheme —
 * it is an invitation to authenticate, not a complaint. Anything else gets
 * `invalid_token` plus the reason, which is what a human debugging a client
 * config actually needs.
 */
function challenge(refusal: McpAuthRefusal): string {
	if (refusal.error === 'missing_token') return 'Bearer';
	return `Bearer error="invalid_token", error_description="${quotable(refusal.message)}"`;
}

/** Turn an auth or rate-limit refusal into the response the client sees. */
export function refusalResponse(refusal: McpAuthRefusal): Response {
	if (refusal.status === 429) {
		return jsonRpcError(429, refusal.message, refusal.error, {
			'retry-after': String(retryAfterSeconds(refusal.retryAfterMs))
		});
	}

	return jsonRpcError(401, refusal.message, refusal.error, {
		'www-authenticate': challenge(refusal)
	});
}

/**
 * No usable `TOKEN_SECRET`, so no token can be verified.
 *
 * 503, not 401: the deployment is broken, and a client that retries later may
 * well succeed. The message names the variable, because the person who will read
 * it is whoever is standing up the server.
 */
export function misconfiguredResponse(): Response {
	return jsonRpcError(
		503,
		'this dashboard is not configured for agents: TOKEN_SECRET is missing or too short',
		'server_not_configured',
		{ 'retry-after': '30' }
	);
}
