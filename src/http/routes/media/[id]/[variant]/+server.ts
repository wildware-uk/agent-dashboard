/**
 * `GET /media/:id/:variant` — the only way bytes leave this deployment
 * (design §6, §8).
 *
 * Two things are true of this route and of no other. It is the only route that
 * reads the media directory, and it can only ever address a file that a `media`
 * or `derivatives` row names: the id must be a ULID with a row behind it, the
 * variant must be one `$media` knows, and the filename comes from the variant
 * rather than from the URL. The raw upload directory is not merely unlisted —
 * it lives outside the served tree, so there is nothing in it to address.
 *
 * The cache and hardening headers, and the reason for each, are documented at
 * `src/http/media/serve.ts`. This file is the mount point.
 */
import { createMediaHandler } from '$http/media';
import type { RequestHandler } from './$types';

const media = createMediaHandler();

export const GET: RequestHandler = (event) => media(event);
