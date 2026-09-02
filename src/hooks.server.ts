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
import { assertBodyLimitAllowsUploads, assertClientAddressTrustworthy, loadConfig } from '$config';
import {
	startMediaSweeper,
	startPresenceSweeper,
	startRequestPusher,
	startRequestSweeper
} from '$domain';
import { startDerivativeWorker } from '$media';

assertClientAddressTrustworthy(process.env);

// BODY_SIZE_LIMIT is enforced by adapter-node before any route runs, so a value
// below the upload caps rejects large uploads with a 413 this app never sees,
// after the agent has already spent its upload token. The adapter's default is
// 512K, far below the caps here, so the usual mistake is never setting it.
// Guarded by `building` because loadConfig needs the deployment's secrets, which
// do not exist while the bundle is being built.
if (!building) assertBodyLimitAllowsUploads(process.env, loadConfig(process.env));

// Presence is derived from heartbeats, but a session that stopped beating is
// still an open row, and a later approval gate aimed at one would wait on an
// agent that is not there. The sweeper closes sessions idle beyond ten minutes
// so that gate fails loudly instead (design §4). It resolves its own database
// handle per tick, so starting it here costs nothing until it first runs, and it
// is skipped while building, when there is no deployment to sweep.
if (!building) startPresenceSweeper();

// A request whose deadline has passed is a prompt the owner can no longer
// answer and an agent that has stopped waiting for one. A parked agent times
// itself out at its own deadline (design §5), so this is what clears the ones
// nobody is holding out of the banner. Same shape as above: its own database
// handle per tick, failures logged rather than thrown.
if (!building) startRequestSweeper();

// A request is the one thing that can happen while nobody is looking at the
// dashboard: the agent has stopped, and only the owner can start it again. This
// subscribes to `request.created` and sends a Web Push notification, which is
// the only channel that reaches a closed tab or a phone in a pocket (design §7).
// It is a no-op unless a VAPID keypair is configured, it never awaits anything
// on the publishing path, and a push service that refuses is logged rather than
// thrown — a notification is a nudge, and the request itself is already stored.
if (!building) startRequestPusher();

// Uploads happen before the update that references them, so an agent that
// crashes in between leaves bytes on disk that nothing will ever point at. This
// collects them an hour later (design §3, §6). Same shape as above: it resolves
// its own database handle and settings per tick, and a failure is logged rather
// than thrown.
if (!building) startMediaSweeper();

// Derivatives (design §6 steps 4-5). The worker polls the `media` table for rows
// that are still `pending` with bytes on disk, which is what makes it correct for
// both halves of the problem: a screenshot uploaded a second ago, and the backlog
// a deployment upgraded into this slice with. It resolves its database handle and
// settings on the first tick rather than here, catches every failure, and runs at
// concurrency two — so the worst case is one media item stuck at `failed`, never a
// dashboard that will not boot or a process that exits on a bad file.
//
// An operator can also drain the backlog by hand; see `src/media/README.md`.
if (!building) startDerivativeWorker();

export { authHandle as handle } from './http/auth';
