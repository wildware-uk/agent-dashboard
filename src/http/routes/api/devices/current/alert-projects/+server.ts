/** `PUT /api/devices/current/alert-projects` — which projects the calling phone alerts on. Device key only. */
import { setAlertProjectsHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const put = setAlertProjectsHandler();

export const PUT: RequestHandler = (event) => put(event);
