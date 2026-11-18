/**
 * `POST /api/apps/[view]/state` (migration 041).
 *
 * What an app saved for itself — the open tab, the half-filled form. The work is
 * in `$http/owner`.
 */
import { saveAppStateHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const state = saveAppStateHandler();

export const POST: RequestHandler = (event) => state(event);
