/**
 * `PUT /api/upload/:token` — where an agent's bytes arrive (design §6).
 *
 * Exempt from the owner's session guard by name in `src/http/auth/guard.ts`: the
 * single-use HMAC token in the URL *is* the authorisation, and an agent never
 * meets the owner's cookie. That exemption is load-bearing in both directions,
 * so both halves are tested — `src/http/auth/guard.test.ts` for the exemption
 * itself, `src/http/media/upload.test.ts` for every way the token can be
 * refused.
 *
 * `PUT` is the whole surface. The handler, the status each refusal becomes and
 * the per-token rate limit all live in `$http/media`; this file is the mount
 * point.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOYMENT REQUIREMENT: a reverse proxy in front of this route must      │
 * │ allow a request body as large as MAX_VIDEO_BYTES and must not time out   │
 * │ mid-upload. Under nginx that is `client_max_body_size 200m;` and a       │
 * │ generous `proxy_read_timeout`; the reference Caddy deployment (§12) uses │
 * │ a 300s read timeout for exactly this. Without it the proxy rejects the   │
 * │ upload before this server ever sees it, and the token is wasted.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import { createUploadHandler } from '$http/media';
import type { RequestHandler } from './$types';

const upload = createUploadHandler();

export const PUT: RequestHandler = (event) => upload(event);
