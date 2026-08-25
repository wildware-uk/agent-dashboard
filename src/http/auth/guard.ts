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
 */
export const TOKEN_AUTHED_PREFIXES = ['/mcp', '/api/upload'] as const;

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

/**
 * Sanitise a `redirectTo` before trusting it.
 *
 * A login form that redirects wherever the query string says is an open
 * redirect — a phishing primitive that borrows this deployment's hostname. Only
 * a same-site absolute path survives; everything else becomes the root.
 */
export function safeRedirectTarget(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith('/')) return '/';
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
