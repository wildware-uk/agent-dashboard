/**
 * `GET /api/stream` — the live pipe to the browser (design §4).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOYMENT REQUIREMENT: nginx (or any reverse proxy) MUST NOT buffer     │
 * │ this route, or the dashboard silently never updates.                    │
 * │                                                                          │
 * │   location /api/stream {                                                │
 * │       proxy_pass http://127.0.0.1:3000;                                 │
 * │       proxy_http_version 1.1;      # SSE needs HTTP/1.1 chunking        │
 * │       proxy_buffering off;         # THE one that matters               │
 * │       proxy_cache off;                                                  │
 * │       proxy_set_header Connection '';   # don't forward `close`          │
 * │       proxy_read_timeout 1h;       # longer than the heartbeat, below    │
 * │   }                                                                      │
 * │                                                                          │
 * │ With buffering on, nginx holds the response until its buffer fills or    │
 * │ the connection ends, so every event arrives late, in bursts, or never.   │
 * │ Nothing errors: the request is open, the server is writing, the browser  │
 * │ is waiting. It is the single most likely deployment failure in this      │
 * │ product, which is why the response also sends `X-Accel-Buffering: no`    │
 * │ (see `../../../stream/frames.ts`) as a belt to these braces, and why     │
 * │ heartbeat comment frames go out every 15s so a proxy that idles the      │
 * │ connection out drops it fast instead of wedging it.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Everything else lives in `$http/stream`: the frame format, the
 * `Last-Event-ID` replay, the single `resync` when the ring buffer cannot cover
 * the gap, and the teardown that unsubscribes from the bus when the client goes
 * away. This file is the mount point and the warning above.
 *
 * The owner's session is required. `src/hooks.server.ts` already refuses an
 * unauthenticated `/api/...` request; the handler checks again for itself,
 * because this one connection carries every event in the deployment.
 */
import { createStreamHandler } from '../../../stream';
import type { RequestHandler } from './$types';

const stream = createStreamHandler();

export const GET: RequestHandler = (event) => stream(event);
