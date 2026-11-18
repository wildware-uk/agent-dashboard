/** `PUT /api/devices/current/live-activity` — the calling phone's Live Activity tokens. */
import { setLiveActivityHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const put = setLiveActivityHandler();

export const PUT: RequestHandler = (event) => put(event);
