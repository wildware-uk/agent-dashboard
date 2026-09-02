/**
 * The owner's push subscription (design §7).
 *
 * Three endpoints on one path, because they are three verbs on one resource:
 * "what is the key", "here is my browser", "forget my browser". The same rules
 * as the rest of `../owner/` — the domain does the work, the session is checked
 * through the wrapper rather than written again, and a domain error becomes its
 * status.
 *
 * **The subscription is never echoed back.** A subscription carries the
 * browser's own encryption keys, and a response that repeated them would put
 * them somewhere they do not need to be for no gain: the browser already has
 * them, and nothing else may.
 *
 * **Push being off is a `conflict`, not a 404.** The route exists; the
 * deployment has not been given a keypair. Telling the browser that plainly is
 * what lets it hide the toggle instead of offering a subscription that could
 * never be delivered to.
 */
import {
	DEFAULT_PUSH_TYPES,
	conflict,
	invalid,
	listPushSubscriptionsFor,
	setDevicePrefs,
	subscribeToPush,
	unsubscribeFromPush
} from '$domain';
import { loadConfig, pushConfig, type PushConfig } from '$config';
import { ownerAction, readOwnerJson, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/** Production reads the environment; a test hands over a keypair or `null`. */
export type PushSettings = () => PushConfig | null;

export type PushHandlerOptions = OwnerHandlerOptions & { settings?: PushSettings };

const environmentSettings: PushSettings = () => pushConfig(loadConfig(process.env));

/**
 * `GET /api/push` — is push available, and against which key?
 *
 * The public key is not a secret: it is what the browser must subscribe
 * against, and a push service will hand it to anybody holding a subscription
 * anyway. The private half never leaves this process.
 */
export function pushStatusHandler(options: PushHandlerOptions = {}): OwnerHandler {
	const settings = options.settings ?? environmentSettings;
	return ownerAction(options, (_event, ctx) => {
		const push = settings();
		const subscriptions = listPushSubscriptionsFor(ctx);

		return Promise.resolve({
			status: 200,
			body: {
				enabled: push !== null,
				publicKey: push?.publicKey ?? null,
				// The count stays for anything that only wants the number, and the
				// list is what lets a browser find *itself* — a device's preferences
				// are its own, and the only handle it has on the server is the
				// endpoint its push service issued it.
				subscriptions: subscriptions.length,
				devices: subscriptions.map((subscription) => ({
					endpoint: subscription.endpoint,
					label: subscription.label,
					last_sent_at: subscription.lastSentAt,
					// Absent preferences are the default rather than `null` on the
					// wire: a client that had to know the default would be a second
					// place it is written down.
					prefs: subscription.prefs ?? { types: [...DEFAULT_PUSH_TYPES] }
				}))
			}
		});
	});
}

/**
 * `POST /api/push` — store this browser's subscription.
 *
 * Idempotent by endpoint (`src/db/push.ts`), so a browser that re-subscribes on
 * every load stays one row and one notification.
 */
export function subscribePushHandler(options: PushHandlerOptions = {}): OwnerHandler {
	const settings = options.settings ?? environmentSettings;
	return ownerAction(options, async (event, ctx) => {
		if (settings() === null) throw conflict('push is not configured on this deployment');

		const body = await readOwnerJson(event.request);
		const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
		const subscription = subscribeToPush(ctx, {
			endpoint: String(body.endpoint ?? ''),
			keys: { p256dh: String(keys.p256dh ?? ''), auth: String(keys.auth ?? '') },
			label: typeof body.label === 'string' ? body.label : null
		});

		// The endpoint only: the keys stay where the browser put them.
		return { status: 200, body: { subscribed: true, endpoint: subscription.endpoint } };
	});
}

/**
 * `DELETE /api/push?endpoint=…` — forget this browser.
 *
 * The endpoint travels in the query rather than a body, because a `DELETE` with
 * a body is the one shape HTTP clients and proxies disagree about most.
 * `removed` says whether a row actually went, so unsubscribing twice is a
 * truthful 200 rather than an error.
 */
export function unsubscribePushHandler(options: PushHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) => {
		const endpoint = new URL(event.request.url).searchParams.get('endpoint') ?? '';
		return Promise.resolve({
			status: 200,
			body: { removed: unsubscribeFromPush(ctx, endpoint) }
		});
	});
}

/**
 * `PATCH /api/push` — change what one device is notified about.
 *
 * The device is named by its endpoint rather than taken from the session,
 * because the session is the owner and the owner has several devices; which one
 * is being configured is exactly the thing that has to be said.
 *
 * `prefs: null` restores the default (everything). An unknown member is
 * refused rather than dropped — a filter that silently ignores the word it did
 * not understand notifies about more than the owner asked for, and they find out
 * at 2am.
 */
export function pushPrefsHandler(options: PushHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = await readOwnerJson(event.request);
		const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
		if (endpoint === '') throw invalid('endpoint is required');

		const prefs = setDevicePrefs(ctx, endpoint, body.prefs ?? null);

		return { status: 200, body: { prefs } };
	});
}
