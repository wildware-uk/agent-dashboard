/** `GET`/`PUT /api/devices/current/alert-prefs` — which kinds of alert the calling phone gets. Device key only. */
import { alertPrefsHandler, setAlertPrefsHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const get = alertPrefsHandler();
const put = setAlertPrefsHandler();

export const GET: RequestHandler = (event) => get(event);
export const PUT: RequestHandler = (event) => put(event);
