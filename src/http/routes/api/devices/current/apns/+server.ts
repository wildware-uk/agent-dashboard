/** `PUT /api/devices/current/apns` — the calling phone's alert token. Device key only. */
import { setApnsTokenHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const put = setApnsTokenHandler();

export const PUT: RequestHandler = (event) => put(event);
