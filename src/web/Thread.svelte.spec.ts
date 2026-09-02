// The real stylesheet, so the separation is measured rather than asserted by
// class name: a rule that does not exist would pass a class-name check.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Thread from './Thread.svelte';
import { aMessage, anAck } from './testing';

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

/**
 * An acknowledgement lands **under the message it answers** (migration 013).
 *
 * Where it goes is the point: the owner is looking at the line they typed, and
 * a tick anywhere else on the card would be a tick they have to go and find.
 */
describe('what an agent said about a message', () => {
	it('puts the tick under that message and not another', async () => {
		const screen = render(Thread, {
			messages: [
				aMessage({ id: 'm1', body: 'have a look at the migration' }),
				aMessage({ id: 'm2', body: 'and the other thing' })
			],
			acks: { m1: [anAck({ messageId: 'm1', state: 'done' })] },
			agentNames: { a1: 'scout' },
			onreply: replies().onreply
		});

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();

		const items = [...document.querySelectorAll('[data-message]')];
		expect(items[0].querySelector('[data-ack]')).not.toBeNull();
		expect(items[1].querySelector('[data-ack]')).toBeNull();
	});

	it('shows an online agent thinking about it', async () => {
		const screen = render(Thread, {
			messages: [aMessage({ id: 'm1' })],
			acks: { m1: [anAck({ messageId: 'm1', state: 'thinking' })] },
			agentNames: { a1: 'scout' },
			onlineIds: ['a1'],
			onreply: replies().onreply
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('leaves a message alone when nobody has said anything', async () => {
		render(Thread, {
			messages: [aMessage({ id: 'm1' })],
			onreply: replies().onreply
		});

		expect(document.querySelector('[data-ack]')).toBeNull();
	});
});

/**
 * Telling one reply from the next (#feedback: "more visual clarity between
 * replies").
 *
 * The old thread was a run of paragraphs down one shared rail, which read as a
 * single block the moment two replies ran to a few lines each. Every reply now
 * has a top and a bottom of its own, and the owner's are marked the way their
 * posts are — one signal for "mine" across the page.
 */
describe('separating the replies', () => {
	it('gives every reply its own box rather than one shared rail', async () => {
		render(Thread, {
			messages: [
				aMessage({ id: 'm1', author: 'human', body: 'first' }),
				aMessage({ id: 'm2', author: 'agent:a1', body: 'second' })
			],
			agentNames: { a1: 'scout' },
			onreply: replies().onreply
		});

		const items = [...document.querySelectorAll('[data-message]')];
		expect(items).toHaveLength(2);
		for (const item of items) {
			// A background of its own is what separates it from the card behind it;
			// a transparent box would look exactly like the old rail.
			expect(getComputedStyle(item).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
			expect(Number.parseFloat(getComputedStyle(item).borderTopWidth)).toBeGreaterThan(0);
		}
	});

	it('marks the owner’s own replies and leaves the agents’ plain', async () => {
		render(Thread, {
			messages: [
				aMessage({ id: 'm1', author: 'human', body: 'mine' }),
				aMessage({ id: 'm2', author: 'agent:a1', body: 'theirs' })
			],
			agentNames: { a1: 'scout' },
			onreply: replies().onreply
		});

		const [mine, theirs] = [...document.querySelectorAll('[data-message]')];
		expect(mine.getAttribute('data-mine')).toBe('true');
		expect(theirs.getAttribute('data-mine')).toBeNull();
		// Measured, not asserted by class name: the accent rail is the signal.
		expect(Number.parseFloat(getComputedStyle(mine).borderLeftWidth)).toBeGreaterThan(
			Number.parseFloat(getComputedStyle(theirs).borderLeftWidth)
		);
	});

	it('still says who spoke and when', async () => {
		const screen = render(Thread, {
			messages: [aMessage({ id: 'm1', author: 'agent:a1', body: 'on it' })],
			agentNames: { a1: 'scout' },
			onreply: replies().onreply
		});

		await expect.element(screen.getByText('scout')).toBeInTheDocument();
		expect(document.querySelector('[data-message] time')).not.toBeNull();
	});
});
