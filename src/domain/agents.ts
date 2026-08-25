/**
 * Agents and their bearer tokens (design §3, §8).
 *
 * Three rules from §8 shape everything here:
 *
 * 1. A token is **256 bits of randomness**, so it needs no password hashing — an
 *    attacker cannot enumerate the space, and argon2 would only buy latency.
 * 2. Only its **HMAC-SHA256 under `TOKEN_SECRET`** is stored. A stolen database
 *    therefore yields no usable tokens, and the keyed hash means an attacker who
 *    has the file still cannot precompute candidates.
 * 3. The stored hash is confirmed with a **constant-time comparison**, so no
 *    byte-by-byte timing signal escapes.
 *
 * The secret is an argument rather than something read from the environment in
 * here, because the domain stays pure (design §2): `$mcp` passes the value from
 * `$config`, the `mint-token` CLI passes the same one, and tests pass their own.
 *
 * Minting lives in the domain deliberately: the CLI (§10) has to create the
 * first token before anyone can log in, and the owner UI mints later ones. Both
 * call this, so a token can only ever be created one way.
 *
 * Nothing here publishes an event. The §4 vocabulary has no agent lifecycle
 * event — presence is derived from session heartbeats, never stored as a flag —
 * so a mint or a revoke has nothing to announce to a browser.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
	findAgentById,
	findAgentByTokenHash,
	insertAgent,
	listAgents as listAgentRows,
	revokeAgent,
	touchAgent,
	type Agent
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { requiredText } from './text';

/** Long enough for `claude-code@laptop`, short enough to render in a rail. */
export const AGENT_NAME_MAX_LENGTH = 100;

/** 256 bits (design §8). */
export const TOKEN_BYTES = 32;

/** Length of {@link TOKEN_BYTES} rendered as unpadded base64url. */
export const TOKEN_LENGTH = 43;

/**
 * The alphabet and length a minted token has.
 *
 * Checking the shape before touching the database is what lets an adapter say
 * "that is not a token" rather than "no such token": the difference matters to a
 * human wiring up a client, and the shape of a token is not a secret, so
 * short-circuiting on it leaks nothing.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isTokenShaped(token: string): boolean {
	return TOKEN_PATTERN.test(token);
}

/**
 * HMAC-SHA256 of a token under the server secret, as lowercase hex.
 *
 * @throws {DomainError} `invalid_argument` if the secret is empty — an unkeyed
 *   hash would silently turn every stored row into a plain digest an attacker
 *   with the file could grind offline.
 */
export function hashAgentToken(token: string, secret: string): string {
	if (secret === '') throw invalid('token secret is required');
	return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

/**
 * Compare two strings without leaking where they first differ.
 *
 * Both values here are hex HMACs, so they are the same length in every real
 * call; the length guard exists so a planted or migrated row cannot make
 * `timingSafeEqual` throw on mismatched buffers.
 */
export function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export type MintAgentTokenInput = {
	name: string;
	/** `TOKEN_SECRET` (design §10). Supplied by the adapter, never read in here. */
	secret: string;
};

/**
 * The one and only result of minting: the row, plus the token in clear.
 *
 * The token is returned exactly once and never stored, so a caller that loses it
 * has to mint another. That is the point.
 */
export type MintedAgentToken = { agent: Agent; token: string };

/** Create an agent and its first token. */
export function mintAgentToken(ctx: DomainContext, input: MintAgentTokenInput): MintedAgentToken {
	const name = requiredText(input.name, 'name', AGENT_NAME_MAX_LENGTH);
	const token = randomBytes(TOKEN_BYTES).toString('base64url');
	const agent = insertAgent(ctx.db, {
		name,
		tokenHash: hashAgentToken(token, input.secret),
		createdAt: ctx.now()
	});

	return { agent, token };
}

/** Why a bearer token did not resolve to an agent. */
export type AgentAuthFailure =
	/** No `Authorization: Bearer` value at all. */
	| 'missing_token'
	/** Present, but not the shape this server issues. */
	| 'malformed_token'
	/** Well formed, but no agent holds it — including a token from another deployment. */
	| 'unknown_token'
	/** Known, and deliberately switched off. */
	| 'revoked_token';

/**
 * The verdict on a bearer token.
 *
 * `message` is written to be shown to whoever sent the token: an agent author
 * debugging a client config is the reader, and "revoked" versus "unknown" is the
 * difference between "ask the owner for a new token" and "check the URL".
 */
export type AgentAuthResult =
	{ ok: true; agent: Agent } | { ok: false; reason: AgentAuthFailure; message: string };

export type AuthenticateAgentInput = {
	token: string | null | undefined;
	secret: string;
};

const FAILURE_MESSAGES: Record<AgentAuthFailure, string> = {
	missing_token: 'missing bearer token: send Authorization: Bearer <agent token>',
	malformed_token: 'malformed bearer token: not a token this server issued',
	unknown_token: 'unknown bearer token: no agent holds it',
	revoked_token: 'revoked bearer token: ask the dashboard owner to mint a new one'
};

function refuse(reason: AgentAuthFailure): AgentAuthResult {
	return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}

/**
 * Resolve a bearer token to the agent that owns it.
 *
 * A read, not a write: nothing is recorded here, so the caller decides whether a
 * successful call is worth a {@link noteAgentSeen}.
 *
 * The lookup is by hash, which SQLite answers from a unique index, and the row
 * it returns is then confirmed byte-wise in constant time. The index lookup is
 * not itself constant time, but the value it compares is an HMAC under a secret
 * the client does not have: a caller cannot aim at a stored hash it has never
 * seen, so there is no digest to walk one byte at a time. The final comparison
 * is the one an attacker could otherwise measure, and that one is
 * {@link constantTimeEquals}.
 */
export function authenticateAgent(
	ctx: DomainContext,
	input: AuthenticateAgentInput
): AgentAuthResult {
	const token = input.token?.trim() ?? '';
	if (token === '') return refuse('missing_token');
	if (!isTokenShaped(token)) return refuse('malformed_token');

	const tokenHash = hashAgentToken(token, input.secret);
	const agent = findAgentByTokenHash(ctx.db, tokenHash);
	if (!agent || !constantTimeEquals(agent.tokenHash, tokenHash)) return refuse('unknown_token');
	// Revoked rows come back from the repository on purpose: telling a revoked
	// token from an unknown one is a policy call, and this is where it is made.
	if (agent.revokedAt !== null) return refuse('revoked_token');

	return { ok: true, agent };
}

/**
 * Record that the agent was heard from (design §3, `agents.last_seen_at`).
 *
 * Never moves backwards, and says nothing about an agent that is not there:
 * "when did we last hear from you" is bookkeeping, not a rule that can fail.
 */
export function noteAgentSeen(ctx: DomainContext, agentId: string): void {
	touchAgent(ctx.db, agentId, ctx.now());
}

/** Every agent, oldest first. Revoked ones are hidden unless asked for. */
export function listAgents(ctx: DomainContext, filter: { includeRevoked?: boolean } = {}): Agent[] {
	return listAgentRows(ctx.db, filter);
}

/**
 * Every agent id mapped to its display name (design §7).
 *
 * The timeline needs this and presence cannot supply it: presence answers "who
 * is beating right now", while most of a timeline was posted by agents that have
 * long since gone away. So this deliberately includes **revoked** agents too —
 * revoking a token ends what an agent can do, not what it already did, and its
 * updates are still on screen.
 *
 * A map rather than a list because every caller is asking the same question of
 * it, one id at a time, and a self-hosted dashboard has tens of agents, not
 * thousands: the whole answer is smaller than one page of the timeline it
 * annotates.
 */
export function listAgentNames(ctx: DomainContext): Record<string, string> {
	const names: Record<string, string> = {};
	for (const agent of listAgentRows(ctx.db, { includeRevoked: true })) {
		names[agent.id] = agent.name;
	}

	return names;
}

/**
 * Switch an agent's token off for good (design §8: individually revocable).
 *
 * @returns whether this call was the one that revoked it, so the CLI can print
 *   "revoked" rather than "already revoked".
 * @throws {DomainError} `not_found` if there is no such agent — a typo'd id must
 *   not read as a successful revoke.
 */
export function revokeAgentToken(ctx: DomainContext, agentId: string): boolean {
	if (!findAgentById(ctx.db, agentId)) throw notFound(`no such agent: ${agentId}`);
	return revokeAgent(ctx.db, agentId, ctx.now());
}
