/**
 * `POST /api/notifications/seen` (migration 021) — clear the bell.
 *
 * `{ ids }` clears those; an empty body clears everything unseen. Seen state is
 * server-side so a bell cleared on the desk is cleared on the phone.
 */
import { markNotificationsSeenHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const seen = markNotificationsSeenHandler();

export const POST: RequestHandler = (event) => seen(event);
