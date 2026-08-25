/**
 * Server hooks.
 *
 * The owner session guard has to be a hook rather than a layout load, because a
 * layout load never runs for a `+server.ts` endpoint and the browser API routes
 * need guarding too (design §8). The guard itself lives in `src/http/auth/`; this
 * file only installs it, so that adding a second hook later is a `sequence(...)`
 * here and nothing else moves.
 *
 * `/mcp` is exempt by path in `src/http/auth/guard.ts`: agents authenticate with
 * bearer tokens (§5) and must never meet the session cookie.
 */
export { authHandle as handle } from './http/auth';
