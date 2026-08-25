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
 *
 * The boot check below runs once at server start, deliberately at module scope: a
 * proxied deployment that does not forward the client address would silently
 * collapse the login rate limiter into a single shared bucket, so it is better to
 * refuse to start than to serve a dashboard the owner can be locked out of.
 */
import { building } from '$app/environment';
import { assertClientAddressTrustworthy } from '$config';
import { startMediaSweeper, startPresenceSweeper } from '$domain';

assertClientAddressTrustworthy(process.env);

// Presence is derived from heartbeats, but a session that stopped beating is
// still an open row, and a later approval gate aimed at one would wait on an
// agent that is not there. The sweeper closes sessions idle beyond ten minutes
// so that gate fails loudly instead (design §4). It resolves its own database
// handle per tick, so starting it here costs nothing until it first runs, and it
// is skipped while building, when there is no deployment to sweep.
if (!building) startPresenceSweeper();

// Uploads happen before the update that references them, so an agent that
// crashes in between leaves bytes on disk that nothing will ever point at. This
// collects them an hour later (design §3, §6). Same shape as above: it resolves
// its own database handle and settings per tick, and a failure is logged rather
// than thrown.
if (!building) startMediaSweeper();

export { authHandle as handle } from './http/auth';
