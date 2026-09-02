/**
 * `GET /api/agent/stream` — an agent's own live pipe (design §4, §5).
 *
 * The agent-facing counterpart to `/api/stream`: a bearer token rather than the
 * owner's cookie, and one event type rather than every event in the
 * deployment. It is exempt from the session guard by name in
 * `src/http/auth/guard.ts` for the same reason `/mcp` is, and does its own auth
 * instead.
 *
 * The same reverse-proxy requirement applies as to `/api/stream`: this response
 * must not be buffered, or an agent connects and then simply never hears
 * anything. See the banner on `../../stream/+server.ts` for the nginx
 * directives; the Caddyfile for this deployment already sets `flush_interval -1`
 * on `/api/stream` and needs the same for this path.
 *
 * Everything else lives in `$http/stream`, so this file stays a mount point.
 */
import { createAgentStreamHandler } from '../../../../stream';
import type { RequestHandler } from './$types';

const stream = createAgentStreamHandler();

export const GET: RequestHandler = (event) => stream(event);
