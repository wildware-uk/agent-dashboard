import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import NotifyToggle from './NotifyToggle.svelte';
import { Push } from './push.svelte';

/**
 * The header's push toggle (design §7).
 *
 * The store is the real one with fake browser APIs behind it, so what these
 * assert is the production rule about when the control may appear at all — not a
 * stand-in for it.
 */
const PUBLIC_KEY = 'BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oek';

function mount(
	options: {
		enabled?: boolean;
		permission?: NotificationPermission;
		granted?: NotificationPermission;
		subscribed?: boolean;
		prefs?: Record<string, string[]>;
	} = {}
) {
	const subscription = {
		endpoint: 'https://push.example/one',
		unsubscribe: vi.fn().mockResolvedValue(true),
		toJSON: () => ({ endpoint: 'https://push.example/one', keys: { p256dh: 'p', auth: 'a' } })
	};
	const pushManager = {
		getSubscription: vi.fn().mockResolvedValue(options.subscribed ? subscription : null),
		subscribe: vi.fn().mockResolvedValue(subscription)
	};
	const notification = {
		permission: options.permission ?? ('default' as NotificationPermission),
		requestPermission: vi.fn().mockResolvedValue(options.granted ?? 'granted')
	};

	const push = new Push({
		fetch: (async (url: string, init?: RequestInit) =>
			(init?.method ?? 'GET') === 'GET'
				? new Response(
						JSON.stringify({
							enabled: options.enabled ?? true,
							publicKey: PUBLIC_KEY,
							subscriptions: options.subscribed ? 1 : 0,
							devices: options.subscribed
								? [
										{
											endpoint: 'https://push.example/one',
											label: 'a phone',
											last_sent_at: null,
											prefs: options.prefs ?? { types: ['request', 'update', 'message'] }
										}
									]
								: []
						})
					)
				: new Response('{}')) as unknown as typeof globalThis.fetch,
		notification,
		serviceWorker: { ready: Promise.resolve({ pushManager }) } as unknown as ServiceWorkerContainer
	});

	return { push, notification, pushManager, screen: render(NotifyToggle, { push }) };
}

describe('the toggle only appears when it could work', () => {
	it('offers notifications once the browser and the deployment both can', async () => {
		const { screen } = mount();

		await expect.element(screen.getByTestId('notify-toggle')).toBeInTheDocument();
		await expect.element(screen.getByText('Notify me')).toBeInTheDocument();
	});

	it('renders nothing on a deployment with no keypair', async () => {
		const { screen } = mount({ enabled: false });

		await expect.element(screen.getByTestId('notify-toggle')).not.toBeInTheDocument();
	});

	it('renders nothing in a browser without the APIs', async () => {
		const screen = render(NotifyToggle, {
			push: new Push({ notification: null, serviceWorker: null })
		});

		await expect.element(screen.getByTestId('notify-toggle')).not.toBeInTheDocument();
	});
});

describe('using it', () => {
	it('raises the permission prompt from the click and nowhere else', async () => {
		const { screen, notification } = mount();
		await expect.element(screen.getByTestId('notify-toggle')).toBeInTheDocument();

		// On screen, and nothing has been asked for yet: a page that prompts on
		// load is one people deny permanently.
		expect(notification.requestPermission).not.toHaveBeenCalled();

		await screen.getByTestId('notify-toggle').click();

		expect(notification.requestPermission).toHaveBeenCalled();
		await expect.element(screen.getByText('Notifying')).toBeInTheDocument();
	});

	it('says it is on, to a screen reader as well as on screen', async () => {
		const { screen } = mount({ subscribed: true, permission: 'granted' });

		await expect
			.element(screen.getByTestId('notify-toggle'))
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('turns back off again', async () => {
		const { screen, pushManager } = mount({ subscribed: true, permission: 'granted' });
		await expect.element(screen.getByText('Notifying')).toBeInTheDocument();

		await screen.getByTestId('notify-toggle').click();

		await expect.element(screen.getByText('Notify me')).toBeInTheDocument();
		expect(pushManager.subscribe).not.toHaveBeenCalled();
	});

	it('goes dead, and says why, when the browser has blocked the site', async () => {
		const { screen } = mount({ permission: 'denied' });
		const toggle = screen.getByTestId('notify-toggle');

		await expect.element(toggle).toBeDisabled();
		await expect
			.element(toggle)
			.toHaveAttribute('aria-label', 'Notifications are blocked in your browser settings');
	});
});

/**
 * What this device is notified about (design §7).
 *
 * Per device rather than per account, because "buzz my phone for questions only,
 * tell my laptop everything" is one owner with two rules.
 */
describe('per-device settings', () => {
	it('offers no settings until this browser is subscribed', async () => {
		const { screen } = mount();

		await expect.element(screen.getByTestId('notify-settings')).not.toBeInTheDocument();
	});

	it('opens a panel with the three things an owner filters on', async () => {
		const { screen } = mount({ subscribed: true, permission: 'granted' });

		await screen.getByTestId('notify-settings').click();

		await expect.element(screen.getByTestId('notify-panel')).toBeInTheDocument();
		await expect.element(screen.getByText('Tell me about')).toBeInTheDocument();
		await expect.element(screen.getByText('Update levels')).toBeInTheDocument();
		await expect.element(screen.getByText('Update priority')).toBeInTheDocument();
	});

	it('shows the default as everything, which is what the toggle promised', async () => {
		const { screen } = mount({ subscribed: true, permission: 'granted' });

		await screen.getByTestId('notify-settings').click();

		await expect.element(screen.getByRole('checkbox', { name: 'Questions' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'Updates' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'Replies' })).toBeChecked();
		// Absent lists mean "allow", the same rule the server applies.
		await expect.element(screen.getByRole('checkbox', { name: 'Error' })).toBeChecked();
	});

	it('reflects what this device already chose', async () => {
		const { screen } = mount({
			subscribed: true,
			permission: 'granted',
			prefs: { types: ['update'], levels: ['error'] }
		});

		await screen.getByTestId('notify-settings').click();

		await expect.element(screen.getByRole('checkbox', { name: 'Updates' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'Questions' })).not.toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'Info' })).not.toBeChecked();
	});

	it('says out loud that these settings are this device’s alone', async () => {
		const { screen } = mount({ subscribed: true, permission: 'granted' });

		await screen.getByTestId('notify-settings').click();

		await expect.element(screen.getByText(/This device only/)).toBeInTheDocument();
	});
});
