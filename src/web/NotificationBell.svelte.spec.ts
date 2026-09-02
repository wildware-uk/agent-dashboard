// The real stylesheet, so the unread marker is measured rather than named.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import NotificationBell from './NotificationBell.svelte';
import { Notifications } from './notifications.svelte';
import type { NotificationsSnapshot, NotificationView } from './types';

/**
 * The bell (migration 021).
 *
 * The owner's ask was that every notification be reachable in the app and that
 * clicking one take them to the thing itself. Both are asserted here: the list
 * renders what the server recorded, and a click navigates to the row's own path
 * while clearing only that row.
 */

function aNotification(overrides: Partial<NotificationView> = {}): NotificationView {
	return {
		id: 'n1',
		seq: 1,
		kind: 'reply',
		projectId: 'p1',
		projectSlug: 'agent-dashboard',
		projectName: 'Agent Dashboard',
		updateId: null,
		messageId: 'm1',
		requestId: null,
		agentId: 'a1',
		title: 'scout replied to you',
		body: 'it works now',
		createdAt: Date.UTC(2026, 8, 2, 12, 0),
		seenAt: null,
		path: '/projects/agent-dashboard?focus=m1',
		...overrides
	};
}

/** A store holding a canned list, with its writes recorded. */
function aStore(items: NotificationView[]) {
	const seen: (readonly string[] | undefined)[] = [];
	const snapshot: NotificationsSnapshot = {
		seq: 1,
		at: new Date().toISOString(),
		notifications: items,
		unseen: items.filter((item) => item.seenAt === null).length
	};

	const store = new Notifications({
		fetch: () => Promise.resolve(new Response(JSON.stringify(snapshot))),
		post: (_url, init) => {
			seen.push(
				(JSON.parse(String(init.body)) as { ids?: string[] }).ids as readonly string[] | undefined
			);
			return Promise.resolve(new Response(JSON.stringify({ changed: 1, unseen: 0 })));
		}
	});
	store.items = items;
	store.unseen = snapshot.unseen;
	return { store, seen };
}

describe('the bell', () => {
	it('counts what has not been read', async () => {
		const { store } = aStore([aNotification(), aNotification({ id: 'n2', seenAt: null })]);
		const screen = render(NotificationBell, { notifications: store });

		await expect.element(screen.getByLabelText('Notifications, 2 unread')).toBeVisible();
		expect(document.querySelector('[data-unseen]')?.textContent?.trim()).toBe('2');
	});

	it('shows no count when everything has been read', async () => {
		const { store } = aStore([aNotification({ seenAt: Date.now() })]);
		render(NotificationBell, { notifications: store });

		expect(document.querySelector('[data-unseen]')).toBeNull();
	});

	it('lists what happened when opened', async () => {
		const { store } = aStore([aNotification()]);
		const screen = render(NotificationBell, { notifications: store });

		await screen.getByRole('button', { name: 'Notifications, 1 unread' }).click();

		await expect.element(screen.getByText('scout replied to you')).toBeVisible();
		await expect.element(screen.getByText('it works now')).toBeVisible();
	});

	it('takes the owner to the thing itself, and clears only that one', async () => {
		const { store, seen } = aStore([
			aNotification(),
			aNotification({
				id: 'n2',
				messageId: 'm2',
				body: 'a second one',
				path: '/projects/x?focus=m2'
			})
		]);
		const went: string[] = [];
		const screen = render(NotificationBell, {
			notifications: store,
			go: (path: string) => went.push(path)
		});

		await screen.getByRole('button', { name: 'Notifications, 2 unread' }).click();
		await screen.getByText('it works now').click();

		expect(went).toEqual(['/projects/agent-dashboard?focus=m1']);
		// The one clicked, not the list: opening a reply must not wipe the rest.
		expect(seen).toEqual([['n1']]);
	});

	it('can clear the lot, deliberately', async () => {
		const { store, seen } = aStore([aNotification()]);
		const screen = render(NotificationBell, { notifications: store });

		await screen.getByRole('button', { name: 'Notifications, 1 unread' }).click();
		await screen.getByRole('button', { name: 'Mark all read' }).click();

		expect(seen).toEqual([undefined]);
	});

	it('says so when there is nothing yet', async () => {
		const { store } = aStore([]);
		const screen = render(NotificationBell, { notifications: store });

		await screen.getByRole('button', { name: 'Notifications' }).click();

		await expect.element(screen.getByText(/Nothing yet/)).toBeVisible();
	});
});
