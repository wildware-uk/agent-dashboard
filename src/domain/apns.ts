/**
 * Apple push (APNs), for the iOS companion app.
 *
 * The same nudge Web Push gives a browser (`./push.ts`), sent to every phone
 * that registered an alert token. The words are not written twice: the title,
 * body, link and collapse tag come from the Web Push builders, and this file
 * only adds what an iOS notification needs on top — a category for its buttons,
 * a thread, and enough to answer or reply without opening the app.
 *
 * Like Web Push it is a nudge, not the record: nothing is queued or retried, and
 * nothing here ever throws into the caller.
 *
 * The transport is HTTP/2 straight to Apple with an ES256 provider token. It is
 * injected everywhere, so tests never open a socket.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import {
	findMessageById,
	findProjectById,
	findUpdateById,
	listOwnerDevices,
	markOwnerDevicePushed,
	markOwnerDevicePushFailed,
	type ApnsEnvironment,
	type OwnerDevice,
	type OwnerDeviceTokenColumn
} from '$db';
import { bus as sharedBus, type EventBus } from '$events';
import { apnsConfig, loadConfig, type ApnsConfig } from '$config';
import { context as sharedContext, type DomainContext } from './context';
import { deviceWantsAlert, forgetDeviceToken } from './devices';
import {
	notifies,
	replyMessage,
	requestMessage,
	updateMessage,
	type Notifiable,
	type PushMessage
} from './push';
import { findRequest } from './requests';

export type { ApnsConfig };

export type ApnsRequest = {
	environment: ApnsEnvironment;
	deviceToken: string;
	headers: Record<string, string>;
	payload: string;
};

export type ApnsResponse = { status: number; reason: string | null };

export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>;

export type ApnsSettings = () => ApnsConfig | null;

export const environmentApnsSettings: ApnsSettings = () => {
	try {
		return apnsConfig(loadConfig(process.env));
	} catch {
		return null;
	}
};

const HOSTS: Record<ApnsEnvironment, string> = {
	production: 'https://api.push.apple.com',
	sandbox: 'https://api.sandbox.push.apple.com'
};

/** Apple refuses tokens older than an hour and throttles re-signing faster than 20 minutes. */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const IDLE_SESSION_MS = 10 * 60 * 1000;

/** Same window as Web Push: a notification about a request that has expired is worse than none. */
export const APNS_EXPIRATION_S = 15 * 60;

/** Apple's limit on `apns-collapse-id`. */
export const COLLAPSE_ID_MAX_BYTES = 64;

/**
 * Room for the raw markdown inside Apple's 4 KB payload, beside the plain-text
 * alert, the title and the routing fields.
 */
export const MARKDOWN_MAX_BYTES = 2048;

/** The `aps` category the app registers its notification actions under. */
export type ApnsCategory = 'REQUEST' | 'MESSAGE' | 'UPDATE';

/**
 * Signs the provider token, and keeps it for {@link PROVIDER_TOKEN_TTL_MS}.
 *
 * The key file is read on first use rather than at boot, so a missing key fails
 * the send (logged) instead of the whole dashboard.
 */
export function createProviderTokenSigner(
	settings: ApnsConfig,
	readKey: (path: string) => string = (path) => readFileSync(path, 'utf8')
): { token(now: number): string; invalidate(): void } {
	let key: KeyObject | null = null;
	let cached: { token: string; at: number } | null = null;

	return {
		token(now) {
			if (cached && now - cached.at < PROVIDER_TOKEN_TTL_MS) return cached.token;
			key ??= createPrivateKey(readKey(settings.keyPath));
			const header = base64url(JSON.stringify({ alg: 'ES256', kid: settings.keyId }));
			const claims = base64url(
				JSON.stringify({ iss: settings.teamId, iat: Math.floor(now / 1000) })
			);
			const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
				key,
				dsaEncoding: 'ieee-p1363'
			}).toString('base64url');
			cached = { token: `${header}.${claims}.${signature}`, at: now };
			return cached.token;
		},
		invalidate() {
			cached = null;
		}
	};
}

function base64url(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64url');
}

export type ApnsTransportOptions = {
	readKey?: (path: string) => string;
	connect?: (authority: string) => ClientHttp2Session;
	now?: () => number;
};

/** HTTP/2 to Apple: one session per host, reopened after any error or close. */
export function createApnsTransport(
	settings: ApnsConfig,
	options: ApnsTransportOptions = {}
): ApnsTransport {
	const signer = createProviderTokenSigner(settings, options.readKey);
	const open = options.connect ?? ((authority: string) => connect(authority));
	const now = options.now ?? Date.now;
	const sessions = new Map<string, ClientHttp2Session>();

	const session = (authority: string): ClientHttp2Session => {
		const existing = sessions.get(authority);
		if (existing && !existing.closed && !existing.destroyed) return existing;

		const created = open(authority);
		const forget = () => {
			if (sessions.get(authority) === created) sessions.delete(authority);
		};
		created.on('error', forget);
		created.on('close', forget);
		created.on('goaway', forget);
		created.setTimeout(IDLE_SESSION_MS, () => created.close());
		// Kept open for reuse, but never a reason for the process to stay up: a
		// session that held the event loop kept a stopping server alive until
		// systemd killed it. A request in flight still holds the loop while it runs.
		created.unref?.();
		sessions.set(authority, created);
		return created;
	};

	return (request) =>
		new Promise<ApnsResponse>((resolve, reject) => {
			let settled = false;
			const finish = (outcome: () => void) => {
				if (settled) return;
				settled = true;
				outcome();
			};

			const stream = session(HOSTS[request.environment]).request({
				':method': 'POST',
				':path': `/3/device/${request.deviceToken}`,
				authorization: `bearer ${signer.token(now())}`,
				'content-type': 'application/json',
				...request.headers
			});

			let status = 0;
			const chunks: Buffer[] = [];
			stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(constants.NGHTTP2_CANCEL));
			stream.on('response', (headers) => {
				status = Number(headers[':status'] ?? 0);
			});
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('end', () =>
				finish(() => {
					const reason = readReason(Buffer.concat(chunks).toString('utf8'));
					if (status === 403 && /ProviderToken/.test(reason ?? '')) signer.invalidate();
					resolve({ status, reason });
				})
			);
			stream.on('error', (error) => finish(() => reject(error)));
			stream.on('close', () => finish(() => reject(new Error('APNs stream closed early'))));
			stream.end(request.payload);
		});
}

function readReason(body: string): string | null {
	if (body === '') return null;
	try {
		const parsed = JSON.parse(body) as { reason?: unknown };
		return typeof parsed.reason === 'string' ? parsed.reason : null;
	} catch {
		return null;
	}
}

const transports = new Map<string, ApnsTransport>();

/** One transport per key, shared by the alert and Live Activity senders. */
export function sharedApnsTransport(settings: ApnsConfig): ApnsTransport {
	const key = `${settings.teamId}:${settings.keyId}:${settings.keyPath}`;
	let transport = transports.get(key);
	if (!transport) {
		transport = createApnsTransport(settings);
		transports.set(key, transport);
	}
	return transport;
}

const TOKEN_FIELD: Record<OwnerDeviceTokenColumn, keyof OwnerDevice> = {
	apns_token: 'apnsToken',
	live_activity_token: 'liveActivityToken',
	push_to_start_token: 'pushToStartToken'
};

/** Apple saying this token will never work again. */
function isDeadToken(response: ApnsResponse): boolean {
	if (response.status === 410) return true;
	return (
		response.status === 400 &&
		(response.reason === 'BadDeviceToken' || response.reason === 'DeviceTokenNotForTopic')
	);
}

export type DeliveryOutcome = 'sent' | 'removed' | 'failed';

/**
 * Send one push to one of a device's tokens. Never throws.
 *
 * A device is never deleted for failing: it is also the owner's key, and a
 * phone with notifications off still reads the dashboard.
 */
export async function deliverToDevice(
	ctx: DomainContext,
	transport: ApnsTransport,
	device: OwnerDevice,
	column: OwnerDeviceTokenColumn,
	headers: Record<string, string>,
	payload: unknown,
	onError: (error: unknown) => void = () => {}
): Promise<DeliveryOutcome> {
	const token = device[TOKEN_FIELD[column]] as string | null;
	if (!token) return 'failed';

	try {
		const response = await transport({
			environment: device.apnsEnvironment ?? 'production',
			deviceToken: token,
			headers,
			payload: JSON.stringify(payload)
		});
		if (response.status === 200) {
			markOwnerDevicePushed(ctx.db, device.id);
			return 'sent';
		}
		if (isDeadToken(response)) {
			forgetDeviceToken(ctx, device.id, column, token);
			return 'removed';
		}
		markOwnerDevicePushFailed(ctx.db, device.id);
		return 'failed';
	} catch (error) {
		try {
			markOwnerDevicePushFailed(ctx.db, device.id);
		} catch {
			// The database is the thing that broke; there is nowhere to record it.
		}
		onError(error);
		return 'failed';
	}
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, max: number): string {
	if (Buffer.byteLength(text, 'utf8') <= max) return text;
	let out = '';
	for (const character of text) {
		if (Buffer.byteLength(out + character, 'utf8') > max) break;
		out += character;
	}
	return out;
}

/** One notification, with the extras an iOS notification carries. */
export type ApnsAlert = {
	message: PushMessage;
	category: ApnsCategory;
	threadId: string;
	/** What it is about, for a phone that only wants alerts about some projects. */
	projectId: string | null;
	about: Notifiable;
	request?: { id: string; kind: string; options: string[] | null };
	/** Fields for `POST /api/messages` that, with a `body`, land in the same thread. */
	reply?: Record<string, string>;
	/** What the agent wrote, for the app to show styled when the alert is opened up. */
	markdown: string;
};

export function alertPayload(alert: ApnsAlert): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		aps: {
			alert: { title: alert.message.title, body: alert.message.body },
			sound: 'default',
			'thread-id': alert.threadId,
			category: alert.category,
			// Only a question needs the phone's extension (it adds the answer buttons); waking it for
			// every alert holds each one back while the extension starts.
			...(alert.category === 'REQUEST' && { 'mutable-content': 1 }),
			'interruption-level': alert.category === 'REQUEST' ? 'time-sensitive' : 'active'
		},
		url: alert.message.url,
		tag: alert.message.tag,
		markdown: truncateBytes(alert.markdown, MARKDOWN_MAX_BYTES)
	};
	if (alert.request) {
		payload.requestId = alert.request.id;
		payload.requestKind = alert.request.kind;
		payload.options = alert.request.options;
	}
	if (alert.reply) payload.reply = alert.reply;
	return payload;
}

export function alertHeaders(bundleId: string, tag: string, now: number): Record<string, string> {
	return {
		'apns-push-type': 'alert',
		'apns-topic': bundleId,
		'apns-priority': '10',
		'apns-expiration': String(Math.floor(now / 1000) + APNS_EXPIRATION_S),
		'apns-collapse-id': truncateBytes(tag, COLLAPSE_ID_MAX_BYTES)
	};
}

function threadFor(ctx: DomainContext, projectId: string | null): string {
	const project = projectId ? findProjectById(ctx.db, projectId) : undefined;
	return project?.slug ?? 'dashboard';
}

/** The event Web Push announces, as an iOS alert. `null` when there is nothing to say. */
export type AlertSource =
	| { type: 'request.created'; requestId: string }
	| { type: 'update.created'; updateId: string }
	| { type: 'message.created'; messageId: string };

export function apnsAlertFor(
	ctx: DomainContext,
	source: AlertSource,
	base: string
): ApnsAlert | null {
	if (source.type === 'request.created') {
		const message = requestMessage(ctx, source.requestId, base);
		const request = findRequest(ctx, source.requestId);
		if (!message || !request) return null;
		return {
			message,
			category: 'REQUEST',
			threadId: threadFor(ctx, request.projectId),
			projectId: request.projectId,
			about: { type: 'request' },
			markdown: request.question,
			request: {
				id: request.id,
				kind: request.kind,
				options: request.options && request.options.length > 0 ? request.options : null
			}
		};
	}

	if (source.type === 'update.created') {
		const built = updateMessage(ctx, source.updateId, base);
		const update = findUpdateById(ctx.db, source.updateId);
		if (!built || !update) return null;
		return {
			message: built.message,
			category: 'UPDATE',
			threadId: threadFor(ctx, update.projectId),
			projectId: update.projectId,
			about: built.about,
			markdown: update.body,
			reply: { update: update.id }
		};
	}

	const built = replyMessage(ctx, source.messageId, base);
	const message = findMessageById(ctx.db, source.messageId);
	if (!built || !message) return null;
	return {
		message: built.message,
		category: 'MESSAGE',
		threadId: threadFor(ctx, message.projectId),
		projectId: message.projectId,
		about: built.about,
		markdown: message.body,
		// `answers` takes the answered line's thread, whichever kind of thread it is.
		reply: { answers: message.id }
	};
}

export type ApnsResult = { sent: number; removed: number; failed: number };

/**
 * Send one alert to every phone with an alert token that wants it. Never throws.
 */
export async function sendApnsAlert(
	ctx: DomainContext,
	alert: ApnsAlert,
	options: { settings: ApnsConfig; transport: ApnsTransport; onError?: (error: unknown) => void }
): Promise<ApnsResult> {
	const result: ApnsResult = { sent: 0, removed: 0, failed: 0 };
	// Phones have no per-device preferences yet, so they get the defaults.
	if (!notifies(null, alert.about)) return result;

	const devices = listOwnerDevices(ctx.db).filter(
		(device) => device.apnsToken !== null && deviceWantsAlert(device, alert.projectId)
	);
	const headers = alertHeaders(options.settings.bundleId, alert.message.tag, ctx.now());
	const payload = alertPayload(alert);

	const outcomes = await Promise.all(
		devices.map((device) =>
			deliverToDevice(
				ctx,
				options.transport,
				device,
				'apns_token',
				headers,
				payload,
				options.onError
			)
		)
	);
	for (const outcome of outcomes) result[outcome] += 1;
	return result;
}

export type ApnsPusherOptions = {
	context?: () => DomainContext;
	bus?: EventBus;
	settings?: ApnsSettings;
	transport?: ApnsTransport;
	baseUrl?: () => string;
	onError?: (error: unknown) => void;
};

/**
 * Alert the owner's phones on the same three events Web Push answers.
 *
 * @returns an unsubscribe.
 */
export function startApnsPusher(options: ApnsPusherOptions = {}): () => void {
	const {
		context: getContext = sharedContext,
		bus = sharedBus,
		settings: getSettings = environmentApnsSettings,
		baseUrl = () => loadConfig(process.env).PUBLIC_BASE_URL,
		onError = (error: unknown) => console.error('apple push failed', error)
	} = options;

	return bus.subscribe((event) => {
		let source: AlertSource;
		if (event.type === 'request.created') {
			source = { type: event.type, requestId: event.payload.requestId };
		} else if (event.type === 'update.created') {
			source = { type: event.type, updateId: event.payload.updateId };
		} else if (event.type === 'message.created') {
			source = { type: event.type, messageId: event.payload.messageId };
		} else {
			return;
		}

		const settings = getSettings();
		if (settings === null) return;

		void (async () => {
			try {
				const ctx = getContext();
				const alert = apnsAlertFor(ctx, source, baseUrl());
				if (alert === null) return;
				await sendApnsAlert(ctx, alert, {
					settings,
					transport: options.transport ?? sharedApnsTransport(settings),
					onError
				});
			} catch (error) {
				onError(error);
			}
		})();
	});
}
