/**
 * Bearer-token auth for `/mcp` (design §5, §8).
 *
 * Agents never meet the owner's session cookie: `/mcp` is exempt from the
 * session guard by path (`src/http/auth/guard.ts`), and this is what stands in
 * its place. One function decides everything about a caller's right to be here,
 * so no tool can be reached without having gone through it.
 *
 * The order is deliberate:
 *
 * 1. **Header shape** — no credentials, or a scheme we do not speak, is a 401
 *    that costs nothing and touches nothing.
 * 2. **Token shape** — anything that is not the 43-character base64url a mint
 *    produces is refused before the database is asked. Someone wiring up a
 *    client wants "that is not a token", not "no such token".
 * 3. **Rate limit** — keyed on the token's HMAC, spent only once we hold
 *    something that could plausibly be a token, so a client looping on a bad
 *    token is throttled just like a chatty legitimate one.
 * 4. **Identity** — `authenticateAgent` resolves the agent in the domain, with
 *    the constant-time comparison and the revoked/unknown distinction.
 *
 * Nothing here returns an HTTP response: it returns a verdict, and
 * `./responses.ts` turns a refusal into one. That keeps the policy testable
 * without parsing a body.
 */
import {
	authenticateAgent,
	hashAgentToken,
	isTokenShaped,
	noteAgentSeen,
	type Agent,
	type AgentAuthFailure,
	type DomainContext
} from '$domain';
import { retryAfterSeconds, type TokenRateLimiter } from './rate-limit';

/** The only scheme this server speaks. OAuth is an explicit non-goal (design §1). */
export const BEARER_SCHEME = 'bearer';

/** Why a header did not yield a token. */
export type BearerFailure = 'missing_token' | 'unsupported_scheme';

export type BearerResult =
	{ ok: true; token: string } | { ok: false; error: BearerFailure; message: string };

/**
 * Pull the token out of an `Authorization` header.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive, and MCP clients disagree about the capitalisation.
 */
export function readBearerToken(header: string | null | undefined): BearerResult {
	const value = header?.trim() ?? '';
	if (value === '') {
		return {
			ok: false,
			error: 'missing_token',
			message: 'missing Authorization header: send Authorization: Bearer <agent token>'
		};
	}

	const separator = value.search(/\s/);
	const scheme = separator === -1 ? value : value.slice(0, separator);
	if (scheme.toLowerCase() !== BEARER_SCHEME) {
		return {
			ok: false,
			error: 'unsupported_scheme',
			message: `unsupported Authorization scheme "${scheme}": this server accepts Bearer tokens only`
		};
	}

	const token = separator === -1 ? '' : value.slice(separator).trim();
	if (token === '') {
		return {
			ok: false,
			error: 'missing_token',
			message: 'empty bearer token: send Authorization: Bearer <agent token>'
		};
	}

	return { ok: true, token };
}

export type McpAuthInput = {
	request: Request;
	/** The domain context every tool for this request will use. */
	ctx: DomainContext;
	/** `TOKEN_SECRET` (design §10). */
	secret: string;
	rateLimiter: TokenRateLimiter;
};

/** Why a request is not being served. `error` is stable enough to branch on. */
export type McpAuthRefusal =
	| {
			ok: false;
			status: 401;
			error: BearerFailure | AgentAuthFailure;
			message: string;
	  }
	| {
			ok: false;
			status: 429;
			error: 'rate_limited';
			message: string;
			retryAfterMs: number;
	  };

export type McpAuthOutcome =
	| {
			ok: true;
			agent: Agent;
			/** The rate-limit key: the token's HMAC, never the token. */
			tokenHash: string;
	  }
	| McpAuthRefusal;

/** Decide whether this request may run tools, and as whom. */
export function authenticateMcpRequest({
	request,
	ctx,
	secret,
	rateLimiter
}: McpAuthInput): McpAuthOutcome {
	const bearer = readBearerToken(request.headers.get('authorization'));
	if (!bearer.ok) return { ok: false, status: 401, error: bearer.error, message: bearer.message };

	// Shape first, and in the domain's terms, so `/mcp` and the CLI agree on what
	// a token even looks like.
	if (!isTokenShaped(bearer.token)) {
		return {
			ok: false,
			status: 401,
			error: 'malformed_token',
			message: 'malformed bearer token: not a token this server issued'
		};
	}

	const tokenHash = hashAgentToken(bearer.token, secret);
	const verdict = rateLimiter.take(tokenHash);
	if (!verdict.allowed) {
		return {
			ok: false,
			status: 429,
			error: 'rate_limited',
			message: `rate limit exceeded for this token: retry after ${retryAfterSeconds(verdict.retryAfterMs)}s`,
			retryAfterMs: verdict.retryAfterMs
		};
	}

	const auth = authenticateAgent(ctx, { token: bearer.token, secret });
	if (!auth.ok) {
		return { ok: false, status: 401, error: auth.reason, message: auth.message };
	}

	// One write per served request, and the only one this adapter causes by
	// itself: §3's `agents.last_seen_at` is how the owner sees a token being used.
	// The agent handed back is the row as it authenticated — the stamp is for the
	// dashboard, not for this request's tools.
	noteAgentSeen(ctx, auth.agent.id);

	return { ok: true, agent: auth.agent, tokenHash };
}
