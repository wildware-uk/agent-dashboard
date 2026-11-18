/** `PUT /api/devices/current/alert-prefs` — which kinds of alert the calling phone gets. Device key only. */
import { setAlertPrefsHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const put = setAlertPrefsHandler();

export const PUT: RequestHandler = (event) => put(event);
