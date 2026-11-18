/**
 * The owner's phones, and the one-call summary they read.
 *
 * | Route                                  | Does                                          |
 * | -------------------------------------- | --------------------------------------------- |
 * | `POST /api/devices`                    | Mint a device key. The key is shown once.     |
 * | `POST /api/devices/sign-in`            | The owner password in, a device key out.      |
 * | `GET /api/devices`                     | Every device, without its key.                |
 * | `DELETE /api/devices/[id]`             | Revoke one. Its key stops working at once.    |
 * | `PUT /api/devices/current/apns`        | The calling phone's alert token.              |
 * | `PUT /api/devices/current/live-activity` | The calling phone's Live Activity tokens.   |
 * | `PUT /api/devices/current/alert-projects` | Which projects the calling phone alerts on. |
 * | `GET /api/summary`                     | Online agents, waiting requests, open work.   |
 *
 * All owner-authed through {@link ownerAction}, by cookie or by a device key.
 * The `current` routes need to know which phone is calling, so they take a
 * device key only; a cookie caller gets `invalid_argument`.
 */
import {
	context,
	deviceAlertProjects,
	deviceName,
	isDomainError,
	invalid,
	listOwnerDevices,
	mintOwnerDevice,
	ownerSummary,
	revokeOwnerDevice,
	setDeviceAlertProjects,
	setDeviceApnsToken,
	setDeviceLiveActivityTokens,
	type DomainContext,
	type OwnerDevice
} from '$domain';
import { loadConfig } from '$config';
import { ownerPasswordCheck, type PasswordCheck } from '../auth';
import { environmentDevices, requestDevice } from '../stream';
import { ownerAction, readOwnerJson, type OwnerHandler, type OwnerHandlerOptions } from './actions';

export type DeviceHandlerOptions = OwnerHandlerOptions & {
	/** `TOKEN_SECRET`, which device keys are hashed under. */
	secret?: () => string | null;
};

const environmentSecret = (): string | null => {
	try {
		return loadConfig(process.env).TOKEN_SECRET;
	} catch {
		return null;
	}
};

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/** A device as the app sees it. The key and its hash never leave the server. */
function deviceView(ctx: DomainContext, device: OwnerDevice) {
	return {
		id: device.id,
		name: device.name,
		createdAt: iso(device.createdAt),
		lastSeenAt: iso(device.lastSeenAt),
		hasApns: device.apnsToken !== null,
		hasLiveActivity: device.liveActivityToken !== null,
		/** Slugs its alerts are limited to; `null` for every project. */
		alertProjects: deviceAlertProjects(ctx, device)
	};
}

/** `POST /api/devices` — mint a key for a new phone. */
export function createDeviceHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	const secret = options.secret ?? environmentSecret;
	return ownerAction(options, async (event, ctx) => {
		const body = await readOwnerJson(event.request);
		if (typeof body.name !== 'string') throw invalid('name must be a string');

		const key = secret();
		if (!key) return { status: 503, body: { error: 'misconfigured' } };

		const { device, token } = mintOwnerDevice(ctx, { name: body.name, secret: key });
		return {
			status: 201,
			body: {
				device: { id: device.id, name: device.name, createdAt: iso(device.createdAt) },
				token
			}
		};
	});
}

export type SignInEvent = { request: Request; clientAddress: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});

/**
 * `POST /api/devices/sign-in` — `{ password, name }` in, `{ device, token }` out.
 *
 * How the native app signs in. The browser's login form is the same password
 * check, but SvelteKit refuses a form post whose Origin is not the configured
 * one, so an app pointed at a LAN address could never get through it, and it
 * would have had to scrape the cookie besides. This shares the form's rate
 * limit ({@link ownerPasswordCheck}), so it is not a second door for guessing.
 */
export function signInDeviceHandler(
	options: Omit<DeviceHandlerOptions, 'config' | 'devices'> & { check?: PasswordCheck } = {}
) {
	const secret = options.secret ?? environmentSecret;
	const check = options.check ?? ownerPasswordCheck;
	return async (event: SignInEvent): Promise<Response> => {
		try {
			const body = await readOwnerJson(event.request);
			if (typeof body.name !== 'string') throw invalid('name must be a string');
			// Checked before the password, so a typo in the name costs no guess.
			const name = deviceName(body.name);

			const verdict = await check({ password: body.password, clientAddress: event.clientAddress });
			if (!verdict.ok) {
				if (verdict.status === 429) {
					return json(
						429,
						{ error: 'rate_limited', message: verdict.error },
						{ 'retry-after': String(verdict.retryAfterS) }
					);
				}
				if (verdict.status === 503)
					return json(503, { error: 'misconfigured', message: verdict.error });
				return json(400, { error: 'wrong_password', message: verdict.error });
			}

			const key = secret();
			if (!key) return json(503, { error: 'misconfigured' });

			const ctx = options.ctx ? options.ctx() : context();
			const { device, token } = mintOwnerDevice(ctx, { name, secret: key });
			return json(201, {
				device: { id: device.id, name: device.name, createdAt: iso(device.createdAt) },
				token
			});
		} catch (error) {
			if (!isDomainError(error) || error.code !== 'invalid_argument') throw error;
			return json(400, { error: error.code, message: error.message });
		}
	};
}

/** `GET /api/devices` */
export function listDevicesHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (_event, ctx) =>
		Promise.resolve({
			status: 200,
			body: { devices: listOwnerDevices(ctx).map((device) => deviceView(ctx, device)) }
		})
	);
}

/** `DELETE /api/devices/[id]` — idempotent: a second delete answers `removed: false`. */
export function deleteDeviceHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) =>
		Promise.resolve({
			status: 200,
			body: { removed: revokeOwnerDevice(ctx, event.params.id ?? '') }
		})
	);
}

function callingDevice(
	event: Parameters<OwnerHandler>[0],
	options: DeviceHandlerOptions
): OwnerDevice {
	const device = requestDevice(event, options.devices ?? environmentDevices);
	if (!device) {
		throw invalid('this needs a device key: send Authorization: Bearer <device token>');
	}
	return device;
}

/** `PUT /api/devices/current/apns` */
export function setApnsTokenHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const device = callingDevice(event, options);
		const body = await readOwnerJson(event.request);
		setDeviceApnsToken(ctx, device.id, { token: body.token, environment: body.environment });
		return { status: 200, body: { ok: true } };
	});
}

/** `PUT /api/devices/current/live-activity` — an omitted token is left as it was. */
export function setLiveActivityHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const device = callingDevice(event, options);
		const body = await readOwnerJson(event.request);
		if (!('updateToken' in body) && !('pushToStartToken' in body)) {
			throw invalid('send updateToken, pushToStartToken, or both (null clears one)');
		}
		setDeviceLiveActivityTokens(ctx, device.id, {
			...('updateToken' in body ? { updateToken: body.updateToken } : {}),
			...('pushToStartToken' in body ? { pushToStartToken: body.pushToStartToken } : {})
		});
		return { status: 200, body: { ok: true } };
	});
}

/**
 * `PUT /api/devices/current/alert-projects` — `{ projects: [slug, …] }` limits
 * the phone's alerts to those projects; `{ projects: null }` lifts the limit.
 */
export function setAlertProjectsHandler(options: DeviceHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const device = callingDevice(event, options);
		const body = await readOwnerJson(event.request);
		if (!('projects' in body)) throw invalid('send projects: an array of slugs, or null');
		setDeviceAlertProjects(ctx, device.id, body.projects);
		return { status: 200, body: { ok: true } };
	});
}

/** `GET /api/summary` */
export function summaryHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (_event, ctx) =>
		Promise.resolve({ status: 200, body: ownerSummary(ctx) })
	);
}
