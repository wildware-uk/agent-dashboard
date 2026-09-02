// The real stylesheet, so the separation is measured rather than asserted by
// class name: a rule that does not exist would pass a class-name check.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Thread from './Thread.svelte';
import { aMedia, aMessage, anAck, fakeActions } from './testing';

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

/**
 * Cmd as well as Ctrl in the reply box (#feedback: "allow CMD + Enter").
 */
describe('the reply chord', () => {
	it('sends on Cmd+Enter', async () => {
		const { onreply, sent } = replies();
		const screen = render(Thread, { messages: [], onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		const field = screen.getByRole('textbox');
		await field.fill('on it');
		field.element().dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				metaKey: true,
				bubbles: true,
				cancelable: true
			})
		);

		await expect.poll(() => sent).toEqual(['on it']);
	});

	it('names both chords in the box', async () => {
		const screen = render(Thread, { messages: [], onreply: replies().onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();
		const placeholder = screen.getByRole('textbox').element().getAttribute('placeholder') ?? '';
		expect(placeholder).toContain('Cmd');
		expect(placeholder).toContain('Ctrl');
	});
});

/**
 * Images on a reply (migration 016).
 *
 * The box grows a picker only when there is somewhere to upload to, which is
 * what keeps every other spec in this file renderable with no server behind it.
 */
describe('replying with an image', () => {
	const png = (name = 'shot.png') =>
		new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

	function paste(field: Element, files: File[]): void {
		const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
		Object.defineProperty(event, 'clipboardData', { value: { files } });
		field.dispatchEvent(event);
	}

	it('sends the uploaded ids with the reply', async () => {
		const acts = fakeActions();
		const sent: { body: string; mediaIds?: string[] }[] = [];
		const screen = render(Thread, {
			messages: [],
			uploader: acts.actions,
			onreply: (body: string, mediaIds?: string[]) => {
				sent.push({ body, mediaIds });
				return Promise.resolve();
			}
		});

		await screen.getByRole('button', { name: 'Reply' }).click();
		const field = screen.getByRole('textbox').element();
		paste(field, [png()]);
		await expect.poll(() => acts.calls.length).toBe(1);

		await screen.getByRole('textbox').fill('like this');
		await screen.getByRole('button', { name: 'Send reply' }).click();

		await expect.poll(() => sent).toEqual([{ body: 'like this', mediaIds: ['m-shot.png'] }]);
	});

	it('offers no picker at all without somewhere to upload to', async () => {
		const screen = render(Thread, { messages: [], onreply: replies().onreply });

		await screen.getByRole('button', { name: 'Reply' }).click();

		expect(document.querySelector('[data-attachments]')).toBeNull();
	});

	it('shows the images already on a message', async () => {
		render(Thread, {
			messages: [aMessage({ id: 'm1', body: 'here it is' })],
			media: { m1: [aMedia({ id: 'img1', status: 'ready' })] },
			onreply: replies().onreply
		});

		expect(document.querySelector('[data-message] img')).not.toBeNull();
	});
});

/**
 * Deleting a line of the thread (migration 017).
 *
 * The owner asked for this so they could clear the probes they had typed to
 * chase a bug. Two clicks, like the delete on a card: it is not undoable, and a
 * mis-tap on a phone must not take a message with it.
 */
describe('deleting a message', () => {
	it('offers no delete without a handler, so a read-only thread has none', async () => {
		render(Thread, {
			messages: [aMessage({ id: 'm1', author: 'human', body: 'mine' })],
			onreply: replies().onreply
		});

		expect(document.querySelector('[aria-label="Delete this message"]')).toBeNull();
	});

	it('asks before it deletes', async () => {
		const deleted: string[] = [];
		const screen = render(Thread, {
			messages: [aMessage({ id: 'm1', author: 'human', body: 'a probe' })],
			onreply: replies().onreply,
			ondelete: (id: string) => {
				deleted.push(id);
				return Promise.resolve();
			}
		});

		await screen.getByRole('button', { name: 'Delete this message' }).click();
		// Nothing has gone yet: the first click only asks.
		expect(deleted).toEqual([]);

		await screen.getByRole('button', { name: 'Confirm delete' }).click();
		expect(deleted).toEqual(['m1']);
	});

	it('lets the owner back out', async () => {
		const deleted: string[] = [];
		const screen = render(Thread, {
			messages: [aMessage({ id: 'm1', author: 'human', body: 'a probe' })],
			onreply: replies().onreply,
			ondelete: (id: string) => {
				deleted.push(id);
				return Promise.resolve();
			}
		});

		await screen.getByRole('button', { name: 'Delete this message' }).click();
		await screen.getByRole('button', { name: 'Cancel' }).click();

		expect(deleted).toEqual([]);
		await expect.element(screen.getByRole('button', { name: 'Delete this message' })).toBeVisible();
	});

	it('says so when the delete fails, and leaves the message where it was', async () => {
		const screen = render(Thread, {
			messages: [aMessage({ id: 'm1', author: 'human', body: 'a probe' })],
			onreply: replies().onreply,
			ondelete: () => Promise.reject(new Error('offline'))
		});

		await screen.getByRole('button', { name: 'Delete this message' }).click();
		await screen.getByRole('button', { name: 'Confirm delete' }).click();

		await expect.element(screen.getByRole('alert')).toHaveTextContent('offline');
		expect(document.querySelectorAll('[data-message]')).toHaveLength(1);
	});
});
