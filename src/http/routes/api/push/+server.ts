/**
 * `/api/push` — the owner's Web Push subscription (design §7).
 *
 * A thin mount, like every route under `api/`: the handlers live in
 * `$http/owner` so the whole surface is tested without a server.
 */
import {
	pushPrefsHandler,
	pushStatusHandler,
	subscribePushHandler,
	unsubscribePushHandler
} from '$http/owner';
import type { RequestHandler } from './$types';

const status = pushStatusHandler();
const subscribe = subscribePushHandler();
const unsubscribe = unsubscribePushHandler();
const prefs = pushPrefsHandler();

export const GET: RequestHandler = (event) => status(event);
export const POST: RequestHandler = (event) => subscribe(event);
export const PATCH: RequestHandler = (event) => prefs(event);
export const DELETE: RequestHandler = (event) => unsubscribe(event);
