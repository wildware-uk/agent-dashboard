/**
 * `GET /api/notifications` (migration 021) — what the owner has been told about.
 *
 * The bell reads this. The work is in `$http/owner`.
 */
import { listNotificationsHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const list = listNotificationsHandler();

export const GET: RequestHandler = (event) => list(event);
