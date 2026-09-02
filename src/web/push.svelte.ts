/**
 * The browser's half of Web Push (design §7).
 *
 * The one live region in this app whose state is not on the server: whether
 * *this* browser will be notified depends on a permission the OS holds, a
 * service worker registration, and a subscription the push service issued — and
 * two of those three can be revoked without anything telling the dashboard. So
 * this store derives its state by asking the browser every time it is opened,
 * rather than remembering an answer that rots.
 *
 * Three things have to line up before the toggle can say "on", and each has a
 * different fix, which is why they are separate fields rather than one boolean:
 *
 * - **`configured`** — the deployment has a VAPID keypair (`GET /api/push`).
 *   Without it there is nothing to subscribe against, and the toggle hides
 *   rather than offering something that cannot work.
 * - **`permission`** — the OS-level grant. `denied` is terminal from script: no
 *   amount of clicking re-prompts, and only the browser's site settings can undo
 *   it, so the toggle says so instead of retrying.
 * - **`subscribed`** — this browser has a subscription stored on the server.
 *
 * The subscription is created against the deployment's public key, so rotating
 * that key invalidates every stored subscription: the browser would keep a
 * subscription the server can no longer sign for. `enable()` therefore always
 * re-subscribes rather than trusting one it finds, and the server upserts by
 * endpoint (`src/db/push.ts`), so doing that on every load costs one row.
 */

/** What one device is notified about (design §7). Every list is a whitelist. */
export type PushPrefs = {
	/** `request`, `update`, `message`. */
	types?: string[];
	/** Updates only: which levels are worth a notification. */
	levels?: string[];
	/** Updates only: which priorities are. */
	priorities?: string[];
};

/** One subscribed browser, as the owner's dashboard lists them. */
export type PushDevice = {
	endpoint: string;
	label: string | null;
	last_sent_at: number | null;
	prefs: PushPrefs;
};

/** `GET /api/push`: whether this deployment can push, and against which key. */
export type PushStatus = {
	enabled: boolean;
	publicKey: string | null;
	subscriptions: number;
	devices?: PushDevice[];
};

export type PushOptions = {
	fetch?: typeof globalThis.fetch;
	/** Test seam: the permission API. `null` means this browser has none. */
	notification?: Pick<typeof Notification, 'permission' | 'requestPermission'> | null;
	/** Test seam: the registration container. `null` means no service workers. */
	serviceWorker?: ServiceWorkerContainer | null;
};

/** What `permission` is before anything has been able to ask. */
export type PushPermission = NotificationPermission | 'unsupported';

export class Push {
	/** Whether this browser has the three APIs at all. Safari in a tab does not. */
	supported = $state(false);
	/** Whether the deployment has a keypair. Nothing is offered without one. */
	configured = $state(false);
	permission = $state<PushPermission>('unsupported');
	/** Whether this browser currently has a subscription stored on the server. */
	subscribed = $state(false);
	/**
	 * What *this* browser is notified about (design §7).
	 *
	 * Per device rather than per account, because that is the real preference: a
	 * phone that should only buzz for a blocked agent and a desk machine that
	 * wants everything are one owner with two rules.
	 */
	prefs = $state<PushPrefs>({ types: ['request', 'update', 'message'] });
	busy = $state(false);
	error = $state<string | null>(null);

	private publicKey: string | null = null;
	private devices: PushDevice[] = [];
	private readonly fetcher: typeof globalThis.fetch;
	private readonly notification: PushOptions['notification'];
	private readonly container: ServiceWorkerContainer | null;

	constructor(options: PushOptions = {}) {
		this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
		this.notification =
			options.notification !== undefined
				? options.notification
				: typeof Notification === 'undefined'
					? null
					: Notification;
		this.container =
			options.serviceWorker !== undefined
				? options.serviceWorker
				: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
					? navigator.serviceWorker
					: null;

		this.supported = this.notification !== null && this.container !== null;
		this.permission = this.notification?.permission ?? 'unsupported';
	}

	/** Whether the toggle should be on screen at all. */
	get available(): boolean {
		return this.supported && this.configured;
	}

	/**
	 * Ask the server whether push is on, and the browser whether it is subscribed.
	 *
	 * Safe to call on every mount: it is two reads and no writes.
	 */
	async load(): Promise<void> {
		try {
			const response = await this.fetcher('/api/push');
			if (!response.ok) return;
			const status = (await response.json()) as PushStatus;
			this.configured = status.enabled;
			this.publicKey = status.publicKey;
			this.devices = status.devices ?? [];
		} catch {
			// Offline, or the page is being torn down. The toggle stays hidden, which
			// is the same thing it does on a deployment with no keys: nothing is
			// promised that cannot be delivered.
			return;
		}

		if (!this.supported) return;
		this.permission = this.notification?.permission ?? 'unsupported';

		const subscription = await this.currentSubscription();
		this.subscribed = subscription !== null;
		// This device's own row, found by the endpoint its push service issued —
		// the only handle a browser has on the server's idea of it.
		const mine = subscription
			? this.devices.find((device) => device.endpoint === subscription.endpoint)
			: undefined;
		if (mine) this.prefs = mine.prefs;
	}

	/**
	 * Turn notifications on for this browser.
	 *
	 * The permission prompt is only ever raised from here, which is to say from a
	 * click: a dashboard that prompts on load is a dashboard people dismiss
	 * permanently, and `denied` cannot be taken back from script.
	 */
	async enable(): Promise<void> {
		if (!this.available || this.busy) return;
		this.busy = true;
		this.error = null;

		try {
			const granted = await this.notification!.requestPermission();
			this.permission = granted;
			if (granted !== 'granted') {
				this.error =
					granted === 'denied'
						? 'Notifications are blocked for this site in your browser settings.'
						: 'Notifications were not allowed.';
				return;
			}

			const registration = await this.container!.ready;
			// Always a fresh subscription against the current key: one issued against
			// a key this deployment no longer holds would be silently undeliverable.
			const existing = await registration.pushManager.getSubscription();
			if (existing) await existing.unsubscribe();

			const subscription = await registration.pushManager.subscribe({
				// Required by every browser that implements push: a notification the
				// owner never sees is not a use this permission may be spent on.
				userVisibleOnly: true,
				applicationServerKey: decodeKey(this.publicKey ?? '')
			});

			const response = await this.fetcher('/api/push', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...subscription.toJSON(), label: browserLabel() })
			});
			if (!response.ok) throw new Error('the dashboard would not store the subscription');

			this.subscribed = true;
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : 'Could not turn notifications on.';
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Turn them off again.
	 *
	 * Both halves, in this order: the browser stops accepting pushes for this
	 * endpoint, and the server forgets it. Doing the server first would leave a
	 * browser subscribed to a push service nothing will ever send to, which looks
	 * identical to working right up until it matters.
	 */
	async disable(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.error = null;

		try {
			const subscription = await this.currentSubscription();
			if (subscription) {
				await subscription.unsubscribe();
				await this.fetcher(`/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, {
					method: 'DELETE'
				});
			}
			this.subscribed = false;
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : 'Could not turn notifications off.';
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Change what this browser is notified about (design §7).
	 *
	 * Written to the server, not kept locally: the filter has to run where the
	 * notification is sent, which is the only place it can run for a device that
	 * is asleep — and a device asleep is the whole point of push.
	 *
	 * A browser with no subscription has nothing to configure, so this does
	 * nothing rather than failing: the panel is only reachable once notifications
	 * are on, and a race against turning them off is not worth an error.
	 */
	async savePrefs(prefs: PushPrefs): Promise<void> {
		const subscription = await this.currentSubscription();
		if (!subscription) return;

		this.busy = true;
		this.error = null;
		try {
			const response = await this.fetcher('/api/push', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ endpoint: subscription.endpoint, prefs })
			});
			if (!response.ok) throw new Error('the dashboard would not store those settings');
			this.prefs = prefs;
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : 'Could not save those settings.';
		} finally {
			this.busy = false;
		}
	}

	/** One click, whichever way it goes. */
	async toggle(): Promise<void> {
		if (this.subscribed) return this.disable();
		return this.enable();
	}

	private async currentSubscription(): Promise<PushSubscription | null> {
		if (this.container === null) return null;
		try {
			const registration = await this.container.ready;
			return await registration.pushManager.getSubscription();
		} catch {
			return null;
		}
	}
}

/**
 * The VAPID public key as the subscription API wants it.
 *
 * The server states it base64url, because that is what a push service and every
 * other implementation uses; `pushManager.subscribe` wants the raw bytes. This
 * is the one place the two meet.
 */
export function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
	const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
	const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

	// Backed by a plain `ArrayBuffer` on purpose: `applicationServerKey` will not
	// take the `ArrayBufferLike` that `Uint8Array.from` is typed to produce, which
	// could be a `SharedArrayBuffer`.
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** What to call this browser in the owner's subscription list. Best effort. */
function browserLabel(): string {
	if (typeof navigator === 'undefined') return 'a browser';
	return navigator.userAgent.slice(0, 200);
}
