/**
 * `POST /api/media` — the owner's own image upload (migration 016).
 *
 * A thin mount, like every route under `api/`: the handler lives in
 * `$http/owner` so the whole surface is tested without a server.
 */
import { uploadMediaHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const upload = uploadMediaHandler();

export const POST: RequestHandler = (event) => upload(event);
