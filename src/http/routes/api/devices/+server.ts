/**
 * `GET /api/devices` and `POST /api/devices` — the owner's phones. The work is
 * in `$http/owner`.
 */
import { createDeviceHandler, listDevicesHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const list = listDevicesHandler();
const create = createDeviceHandler();

export const GET: RequestHandler = (event) => list(event);
export const POST: RequestHandler = (event) => create(event);
