/** `DELETE /api/devices/[id]` — revoke one phone's key. */
import { deleteDeviceHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const remove = deleteDeviceHandler();

export const DELETE: RequestHandler = (event) => remove(event);
