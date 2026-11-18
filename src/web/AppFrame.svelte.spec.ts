import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import AppFrame from './AppFrame.svelte';
import type { AppView } from './types';

/**
 * An app on a card (migration 041).
 *
 * Two things are worth a browser test here: that nothing runs until the owner
 * asks for it, and that the frame it then runs in is the sandbox the whole
 * feature rests on.
 */
const anApp = (overrides: Partial<AppView> = {}): AppView => ({
	id: 'view1',
	card: { kind: 'update', id: 'card1' },
	uri: 'ui://review-board',
	name: 'Review board',
	description: 'Everything waiting on review',
	url: null,
	title: null,
	data: { open: 3 },
	state: null,
	author: 'agent:a1',
	agentId: 'a1',
	createdAt: 1,
	updatedAt: 1,
	...overrides
});

describe('an app on a card', () => {
	it('is a line, not a running app, until it is pressed', async () => {
		render(AppFrame, { app: anApp() });

		expect(document.querySelector('iframe')).toBeNull();
		const trigger = document.querySelector('[data-app-frame] button') as HTMLButtonElement;
		expect(trigger.textContent).toContain('Review board');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
	});

	it('runs it in a frame with no same-origin privileges', async () => {
		render(AppFrame, { app: anApp() });

		(document.querySelector('[data-app-frame] button') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const frame = document.querySelector('iframe')!;
		// The whole feature rests on this: without `allow-same-origin` the document
		// is on an opaque origin and cannot reach the owner's session.
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('src')).toBe('/apps/view1');
		expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
	});

	it('frames a hosted app on its own origin, and says whose it is', async () => {
		render(AppFrame, { app: anApp({ url: 'https://fix.example.com/embed?q=open' }) });

		(document.querySelector('[data-app-frame] button') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const frame = document.querySelector('iframe')!;
		expect(frame.getAttribute('src')).toBe('https://fix.example.com/embed?q=open');
		// `allow-same-origin` here means the service's own origin, never this
		// dashboard's — which is what lets its session work.
		expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
		// And never the one that would let it move the owner off the dashboard.
		expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
		expect(document.querySelector('[data-app-frame]')?.textContent).toContain(
			'Served by https://fix.example.com'
		);
	});

	it('shows the title the agent gave this showing, when it gave one', async () => {
		render(AppFrame, { app: anApp({ title: '3 to review' }) });

		expect(document.querySelector('[data-app-frame] button')?.textContent).toContain('3 to review');
	});
});
