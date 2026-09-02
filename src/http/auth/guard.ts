/**
 * Which paths the owner's session cookie protects (design §8).
 *
 * Pure path policy, no I/O: the hook and the root layout load both consult this,
 * so "every browser route and browser API route" is one list read in one place
 * rather than a condition repeated per route.
 *
 * The exemptions are the interesting part. Agents authenticate with tokens, not
 * with the owner's cookie, so their surfaces must never be session-guarded — a
 * guard that crept over `/mcp` would break every agent while looking like it was
 * working. Matching is on whole path segments, so `/mcp-docs` is still a browser
 * route.
 */

export const LOGIN_PATH = '/login';
export const LOGOUT_PATH = '/logout';

/**
 * Surfaces authenticated by a token in the request, never by the session cookie.
 *
 * - `/mcp` — MCP Streamable HTTP, `Authorization: Bearer <agent token>` (§5).
 * - `/api/upload` — a single-use HMAC upload token in the URL (§6).
 * - `/s` — a public share link: the token in the path is the whole
 *   authorisation, and it grants exactly one card (`src/domain/shares.ts`). This
 *   is the only unauthenticated *read* of agent-authored content in the product,
 *   which is why the domain hands the route a purpose-built shape rather than
 *   the dashboard's own, and why the media under it is scoped to the same share.
 * - `/api/agent` — an agent's own live stream, `Authorization: Bearer <agent
 *   token>` exactly as `/mcp` (§4, §5). It is under `/api` and would otherwise
 *   be caught by the browser-API rule below, which would refuse every agent
 *   with a 401 the agent could do nothing about.
 */
export const TOKEN_AUTHED_PREFIXES = ['/mcp', '/api/upload', '/s', '/api/agent'] as const;

/** Reachable without a session, or the owner could never get one. */
export const PUBLIC_PREFIXES = [LOGIN_PATH, LOGOUT_PATH] as const;

/** Whole-segment prefix match: `/mcp` covers `/mcp/messages`, not `/mcpx`. */
function under(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** A trailing slash is the same route, and must not be a way around the guard. */
function normalise(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** Does a request for this path need the owner's session? */
export function requiresSession(pathname: string): boolean {
	const path = normalise(pathname);
	return ![...TOKEN_AUTHED_PREFIXES, ...PUBLIC_PREFIXES].some((prefix) => under(path, prefix));
}

/** Is this a browser API call, which wants a status code rather than a login page? */
export function isBrowserApi(pathname: string): boolean {
	return requiresSession(pathname) && under(normalise(pathname), '/api');
}

/**
 * Where to send an unauthenticated visitor, remembering where they were going so
 * logging in does not dump them on the dashboard root.
 */
export function loginRedirect(url: URL): string {
	const target = `${url.pathname}${url.search}`;
	if (safeRedirectTarget(target) === '/') return LOGIN_PATH;
	return `${LOGIN_PATH}?redirectTo=${encodeURIComponent(target)}`;
}

/** C0 controls plus DEL — none of which belong in a URL path. */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Sanitise a `redirectTo` before trusting it.
 *
 * A login form that redirects wherever the query string says is an open
 * redirect — a phishing primitive that borrows this deployment's hostname. Only
 * a same-site absolute path survives; everything else becomes the root.
 */
export function safeRedirectTarget(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith('/')) return '/';
	// Control characters have to be rejected on the raw string, before `new URL()`
	// below silently strips them: a surviving CR/LF reaches `redirect()`, which
	// refuses to put it in a Location header and throws, so a *correct* password
	// would land the owner on a 500 instead of the dashboard. Written as a
	// codepoint test rather than a regex because a control-character class in a
	// literal is itself unreadable (and `no-control-regex` says so).
	if (hasControlCharacter(raw)) return '/';
	// `//host` and `/\host` are both protocol-relative in browsers.
	if (/^\/[/\\]/.test(raw)) return '/';
	if (raw === '/') return '/';

	const path = normalise(new URL(raw, 'http://placeholder.invalid').pathname);
	// Bouncing the owner back to a route that signs them out, or to the login
	// page they just left, is never what they wanted.
	if (PUBLIC_PREFIXES.some((prefix) => under(path, prefix))) return '/';
	if (!requiresSession(path)) return '/';

	return raw;
}
