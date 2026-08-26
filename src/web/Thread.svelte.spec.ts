import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Thread from './Thread.svelte';
import { aMessage } from './testing';

/**
 * The conversation on a card (design §7): the thread, and the box the owner
 * replies in.
 *
 * The markdown cases here are the ones that matter most. `markdown.test.ts`
 * proves the *string* is escaped; this proves the DOM agrees for a **message**
 * body — which reaches the owner's browser through the same renderer with raw
 * HTML disabled (design §8), and would otherwise be the one body on the page
 * that nobody had checked.
 */

/** A reply handler that records what it was given, and answers however told. */
function replies(answer: () => Promise<void> = () => Promise.resolve()) {
	const sent: string[] = [];
	return {
		sent,
		onreply: (body: string) => {
			sent.push(body);
			return answer();
		}
	};
}

describe('untrusted markdown in a message', () => {
	it('renders a script tag as text and creates no element', async () => {
		const screen = render(Thread, {
			messages: [aMessage({ body: 'before <script>window.__pwned = true</script> after' })],
			onreply: replies().onreply
		});

		await expect.element(screen.getByText(/<script>/)).toBeInTheDocument();
		expect(document.querySelector('[data-thread] script')).toBeNull();
		expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
	});

	it('renders an img tag as text, so no onerror handler ever runs', async () => {
		const screen = render(Thread, {
			messages: [aMessage({ body: '<img src=x onerror="window.__pwned = true">' })],
			onreply: replies().onreply
		});

		await expect.element(screen.getByText(/<img src=x/)).toBeInTheDocument();
		expect(document.querySelector('[data-thread] img')).toBeNull();
	});

	it('still renders real markdown as markup', async () => {
		render(Thread, {
			messages: [aMessage({ body: '**shipped**' })],
			onreply: replies().onreply
		});

		expect(document.querySelector('[data-thread] strong')?.textContent).toBe('shipped');
	});
});

describe('the thread', () => {
	it('reads downwards, oldest first, and says who said what', async () => {
		const screen = render(Thread, {
			messages: [
				aMessage({ id: 'm1', body: 'from the owner', author: 'human' }),
				aMessage({ id: 'm2', body: 'from the agent', author: 'agent:a1' })
			],
			agentNames: { a1: 'scout' },
			onreply: replies().onreply
		});

		const bodies = [...document.querySelectorAll('[data-message]')].map((node) =>
			node.textContent?.replace(/\s+/g, ' ')
		);
		expect(bodies[0]).toContain('from the owner');
		expect(bodies[1]).toContain('from the agent');
		await expect.element(screen.getByText('You')).toBeInTheDocument();
		await expect.element(screen.getByText('scout')).toBeInTheDocument();
	});

	it('names an agent it has no name for readably, never as a raw ULID', async () => {
		render(Thread, {
			messages: [aMessage({ author: 'agent:01K3ABCDEFGHJKMNPQRSTVWXYZ' })],
			onreply: replies().onreply
		});

		const label = document.querySelector('[data-message-author]')?.textContent ?? '';
		expect(label).not.toBe('01K3ABCDEFGHJKMNPQRSTVWXYZ');
		expect(label.length).toBeLessThan(20);
	});

	it('renders nothing but the reply affordance when nobody has replied', async () => {
		const screen = render(Thread, { onreply: replies().onreply });

		expect(document.querySelectorAll('[data-message]')).toHaveLength(0);
		await expect.element(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
	});
});

describe('replying', () => {
	it('stays out of the way until it is wanted', async () => {
		const screen = render(Thread, { onreply: replies().onreply });

		expect(screen.getByLabelText('Reply to this update').elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole('button', { name: 'Reply' }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	it('sends what was typed, then closes and forgets it', async () => {
		const api = replies();
		const screen = render(Thread, { onreply: api.onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByLabelText('Reply to this update').fill('  try the other branch  ');
		await screen.getByRole('button', { name: 'Send reply' }).click();

		expect(api.sent).toEqual(['try the other branch']);
		expect(screen.getByLabelText('Reply to this update').elements()).toHaveLength(0);
	});

	it('refuses to send a blank reply', async () => {
		const api = replies();
		const screen = render(Thread, { onreply: api.onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByLabelText('Reply to this update').fill('   ');

		await expect.element(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
		expect(api.sent).toEqual([]);
	});

	it('keeps the box open holding what was typed when the server refuses', async () => {
		const api = replies(() => Promise.reject(new Error('body is required')));
		const screen = render(Thread, { onreply: api.onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByLabelText('Reply to this update').fill('doomed');
		await screen.getByRole('button', { name: 'Send reply' }).click();

		await expect.element(screen.getByText('body is required')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Reply to this update')).toHaveValue('doomed');
	});

	it('does not insert the reply itself: the stream brings it back', async () => {
		const api = replies();
		const screen = render(Thread, { onreply: api.onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByLabelText('Reply to this update').fill('optimism is a bug');
		await screen.getByRole('button', { name: 'Send reply' }).click();

		expect(document.querySelectorAll('[data-message]')).toHaveLength(0);
	});
});

describe('on a phone', () => {
	/**
	 * Component specs get the compiled component's own CSS but not the Tailwind
	 * layer, so a thumb-sized target is asserted as the class that sets it — the
	 * same way the card spec asserts its level colour — while the layout itself is
	 * covered at 375px by the e2e pass. What *is* real here is the scroller in
	 * `Markdown.svelte`'s own `<style>`, so the wide-content case below measures
	 * rather than reads a class name (design §7).
	 */
	it('gives both controls a 44px target', async () => {
		const screen = render(Thread, { messages: [aMessage()], onreply: replies().onreply });

		const reply = screen.getByRole('button', { name: 'Reply' }).element();
		expect(reply.className).toContain('min-h-11');

		await screen.getByRole('button', { name: 'Reply' }).click();
		expect(screen.getByRole('button', { name: 'Send reply' }).element().className).toContain(
			'min-h-11'
		);
		expect(screen.getByRole('button', { name: 'Cancel' }).element().className).toContain(
			'min-h-11'
		);
	});

	it('scrolls a wide code block inside itself rather than widening the thread', async () => {
		render(Thread, {
			messages: [aMessage({ body: '```\n' + 'x'.repeat(400) + '\n```' })],
			onreply: replies().onreply
		});
		const container = document.querySelector('[data-thread]') as HTMLElement;
		container.style.width = '375px';

		expect(container.scrollWidth).toBeLessThanOrEqual(375);
	});

	it('offers the reply control without a hover, because a phone cannot hover', async () => {
		const screen = render(Thread, { onreply: replies().onreply });

		await expect.element(screen.getByRole('button', { name: 'Reply' })).toBeVisible();
	});
});

describe('the send button while a reply is in flight', () => {
	it('cannot be pressed twice', async () => {
		let release = () => {};
		const api = replies(() => new Promise<void>((resolve) => (release = resolve)));
		const screen = render(Thread, { onreply: api.onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByLabelText('Reply to this update').fill('once');
		const send = screen.getByRole('button', { name: 'Send reply' });
		await send.click();

		await expect.element(send).toBeDisabled();
		release();
		await vi.waitFor(() => expect(api.sent).toEqual(['once']));
	});
});
