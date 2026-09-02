/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The service worker (design §7).
 *
 * **It exists for one reason: Web Push has nowhere else to run.** A push
 * notification is delivered to the browser while no page of this app is open, so
 * something has to be there to receive it — and a service worker is the only
 * thing that can be.
 *
 * **It deliberately does not cache.** There is no `fetch` handler here, so every
 * request goes to the network exactly as it did before this file existed. A
 * dashboard whose whole point is showing what is happening right now is the
 * worst possible candidate for stale assets served from a cache, and an offline
 * mode would be a screen full of things that are no longer true. Adding a cache
 * later is a decision to make on purpose, not a side effect of wanting
 * notifications.
 *
 * `skipWaiting` and `clients.claim` are here for the same reason: with no cache
 * there is no version skew to be careful about, so a new worker should take over
 * immediately rather than wait for every tab to close.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

/** One button on the notification, and the answer taking it should send. */
type PushAction = { action: string; title: string; value: string | boolean };

/** What `src/domain/push.ts` sends. Anything else is treated as an empty push. */
type PushMessage = {
	title?: string;
	body?: string;
	url?: string;
	tag?: string;
	requestId?: string;
	actions?: PushAction[];
};

sw.addEventListener('install', () => {
	void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
	const message = readMessage(event);

	// `showNotification` is not optional: a browser that granted permission for
	// `userVisibleOnly` subscriptions will show its own "this site was updated in
	// the background" notice if a push produces nothing, which is worse than
	// anything this could say.
	// `actions` is passed through as the server sent it. A browser that
	// implements notification actions shows them on a long press; one that does
	// not ignores the field. Neither is worth branching on here, because tapping
	// the notification body opens the card either way — the buttons are a
	// shortcut, never the only route to an answer.
	const actions = (message.actions ?? []).map(({ action, title }) => ({ action, title }));

	event.waitUntil(
		sw.registration.showNotification(message.title ?? 'Agent Dashboard', {
			body: message.body ?? 'An agent is waiting on you.',
			// Same tag for the same request, so a redelivery replaces the notification
			// rather than stacking a second copy of one blocked agent.
			tag: message.tag ?? 'owner-request',
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			actions,
			data: {
				url: message.url ?? '/',
				requestId: message.requestId,
				// The values live here rather than being parsed back out of a label:
				// the worker is handed an action id and needs to know what it meant.
				actions: message.actions ?? []
			}
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data = (event.notification.data ?? {}) as {
		url?: string;
		requestId?: string;
		actions?: PushAction[];
	};
	const target = data.url ?? '/';
	const chosen = (data.actions ?? []).find((candidate) => candidate.action === event.action);

	event.waitUntil(
		(async () => {
			// A button was pressed: answer where we stand, without opening anything.
			// The request is settled by the time the owner would have finished
			// unlocking their phone, and every open tab hears about it on the stream.
			if (chosen && data.requestId) {
				if (await answer(data.requestId, chosen.value)) return;
				// It did not land — the session expired, somebody answered first, or
				// the network is gone. Falling through opens the card, which is the
				// only honest thing to do: silently swallowing it would leave an agent
				// blocked while the owner believes they unblocked it.
			}

			await open(target);
		})()
	);
});

/**
 * Answer a request from the notification.
 *
 * Same-origin with the owner's cookie, which a service worker sends for us. The
 * endpoint checks the session exactly as it does for the dashboard — a
 * notification is not a second way in, it is the same door with a shorter walk.
 *
 * @returns whether the answer was accepted.
 */
async function answer(requestId: string, value: string | boolean): Promise<boolean> {
	try {
		const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/answer`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ value })
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Focus a tab that is already open rather than opening a second dashboard. */
async function open(target: string): Promise<void> {
	const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const client of clients) {
		await client.focus();
		if ('navigate' in client) await client.navigate(target);
		return;
	}
	await sw.clients.openWindow(target);
}

/** The payload, or an empty object: a push with no body is still a push. */
function readMessage(event: PushEvent): PushMessage {
	try {
		return (event.data?.json() as PushMessage) ?? {};
	} catch {
		return {};
	}
}

export {};
