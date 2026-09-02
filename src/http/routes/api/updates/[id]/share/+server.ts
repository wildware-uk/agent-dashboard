/**
 * `/api/updates/[id]/share` — the owner publishes one card, or takes it back
 * (design §7, §8).
 *
 * A thin mount, like every route under `api/`: the handlers live in
 * `$http/owner` so the whole surface is tested without a server.
 */
import { revokeShareHandler, shareUpdateHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const share = shareUpdateHandler();
const revoke = revokeShareHandler();

export const POST: RequestHandler = (event) => share(event);
export const DELETE: RequestHandler = (event) => revoke(event);
