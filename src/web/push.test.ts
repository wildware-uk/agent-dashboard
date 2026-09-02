import { describe, expect, it, vi } from 'vitest';
import { Push, decodeKey } from './push.svelte';

/**
 * The browser's half of Web Push (design §7).
 *
 * Every browser API is injected, because all three of them — permission, the
 * registration, the subscription — can be in states a test has to be able to
 * put them in, and two of them cannot be reached from a Node test runner at all.
 */
const PUBLIC_KEY = 'BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oek';

function fakeSubscription(endpoint = 'https://push.example/one') {
	return {
		endpoint,
		unsubscribe: vi.fn().mockResolvedValue(true),
		toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } })
	};
}

function setup(
	options: {
		status?: Record<string, unknown>;
		permission?: NotificationPermission;
		granted?: NotificationPermission;
		existing?: ReturnType<typeof fakeSubscription> | null;
	} = {}
) {
	const created = fakeSubscription();
	const pushManager = {
		getSubscription: vi.fn().mockResolvedValue(options.existing ?? null),
		subscribe: vi.fn().mockResolvedValue(created)
	};

	const notification = {
		permission: options.permission ?? ('default' as NotificationPermission),
		requestPermission: vi.fn().mockResolvedValue(options.granted ?? 'granted')
	};

	const posted: { url: string; init?: RequestInit }[] = [];
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		posted.push({ url: String(url), init });
		if (String(url).startsWith('/api/push') && (init?.method ?? 'GET') === 'GET') {
			return new Response(
				JSON.stringify(
					options.status ?? { enabled: true, publicKey: PUBLIC_KEY, subscriptions: 0 }
				),
				{ status: 200 }
			);
		}
		return new Response('{}', { status: 200 });
	});

	const push = new Push({
		fetch: fetch as unknown as typeof globalThis.fetch,
		notification,
		serviceWorker: { ready: Promise.resolve({ pushManager }) } as unknown as ServiceWorkerContainer
	});

	return { push, pushManager, notification, fetch, posted, created };
}

describe('what this browser can be offered', () => {
	it('offers nothing without the APIs, however the deployment is configured', async () => {
		const push = new Push({ notification: null, serviceWorker: null });
		await push.load();

		expect(push.supported).toBe(false);
		expect(push.available).toBe(false);
	});

	it('offers nothing when the deployment has no keypair', async () => {
		const { push } = setup({ status: { enabled: false, publicKey: null, subscriptions: 0 } });
		await push.load();

		expect(push.supported).toBe(true);
		expect(push.available).toBe(false);
	});

	it('is available when the browser and the deployment both can', async () => {
		const { push } = setup();
		await push.load();

		expect(push.available).toBe(true);
	});

	it('reads the subscription back from the browser rather than remembering one', async () => {
		const { push } = setup({ existing: fakeSubscription(), permission: 'granted' });
		await push.load();

		expect(push.subscribed).toBe(true);
	});

	it('stays hidden rather than throwing when the status call fails', async () => {
		const push = new Push({
			fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch,
			notification: { permission: 'default', requestPermission: vi.fn() },
			serviceWorker: {} as ServiceWorkerContainer
		});

		await expect(push.load()).resolves.toBeUndefined();
		expect(push.available).toBe(false);
	});
});

describe('turning it on', () => {
	it('asks for permission, subscribes, and stores it on the server', async () => {
		const { push, pushManager, notification, posted } = setup();
		await push.load();

		await push.enable();

		expect(notification.requestPermission).toHaveBeenCalled();
		expect(pushManager.subscribe).toHaveBeenCalledWith(
			expect.objectContaining({ userVisibleOnly: true })
		);
		const stored = posted.find((call) => call.init?.method === 'POST');
		expect(JSON.parse(String(stored?.init?.body))).toMatchObject({
			endpoint: 'https://push.example/one',
			keys: { p256dh: 'p', auth: 'a' }
		});
		expect(push.subscribed).toBe(true);
	});

	it('subscribes against the deployment key, as bytes', async () => {
		const { push, pushManager } = setup();
		await push.load();

		await push.enable();

		const key = pushManager.subscribe.mock.calls[0][0].applicationServerKey;
		expect(key).toEqual(decodeKey(PUBLIC_KEY));
	});

	it('replaces a subscription issued against an older key', async () => {
		const stale = fakeSubscription('https://push.example/stale');
		const { push, pushManager } = setup({ existing: stale, permission: 'granted' });
		await push.load();

		await push.enable();

		expect(stale.unsubscribe).toHaveBeenCalled();
		expect(pushManager.subscribe).toHaveBeenCalled();
	});

	it('says so, and gives up, when the owner blocks notifications', async () => {
		const { push, pushManager } = setup({ granted: 'denied' });
		await push.load();

		await push.enable();

		expect(push.subscribed).toBe(false);
		expect(push.permission).toBe('denied');
		expect(push.error).toMatch(/blocked/);
		expect(pushManager.subscribe).not.toHaveBeenCalled();
	});

	it('does not raise a prompt on a deployment that could not deliver anyway', async () => {
		const { push, notification } = setup({
			status: { enabled: false, publicKey: null, subscriptions: 0 }
		});
		await push.load();

		await push.enable();

		expect(notification.requestPermission).not.toHaveBeenCalled();
	});

	it('reports a server that would not store the subscription', async () => {
		const { push, fetch } = setup();
		await push.load();
		fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));

		await push.enable();

		expect(push.subscribed).toBe(false);
		expect(push.error).toMatch(/would not store/);
	});
});

describe('turning it off', () => {
	it('unsubscribes the browser first, then forgets it on the server', async () => {
		const existing = fakeSubscription();
		const { push, posted } = setup({ existing, permission: 'granted' });
		await push.load();

		await push.disable();

		expect(existing.unsubscribe).toHaveBeenCalled();
		const deleted = posted.find((call) => call.init?.method === 'DELETE');
		expect(deleted?.url).toBe(
			`/api/push?endpoint=${encodeURIComponent('https://push.example/one')}`
		);
		expect(push.subscribed).toBe(false);
	});

	it('is fine when there was nothing subscribed', async () => {
		const { push } = setup({ permission: 'granted' });
		await push.load();

		await push.disable();

		expect(push.subscribed).toBe(false);
		expect(push.error).toBeNull();
	});

	it('toggles the other way once it is on', async () => {
		const existing = fakeSubscription();
		const { push } = setup({ existing, permission: 'granted' });
		await push.load();
		expect(push.subscribed).toBe(true);

		await push.toggle();

		expect(push.subscribed).toBe(false);
	});
});

describe('decodeKey', () => {
	it('reads base64url, which is not what atob expects', () => {
		expect(decodeKey('AAECA_-9')).toEqual(new Uint8Array([0, 1, 2, 3, 255, 189]));
	});

	it('pads a key whose length is not a multiple of four', () => {
		expect(decodeKey('AAE').length).toBe(2);
	});
});
