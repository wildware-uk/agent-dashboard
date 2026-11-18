/**
 * `POST /api/devices/sign-in` — the native app's sign-in. The work is in
 * `$http/owner`.
 */
import { signInDeviceHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const signIn = signInDeviceHandler();

export const POST: RequestHandler = (event) =>
	signIn({ request: event.request, clientAddress: event.getClientAddress() });
