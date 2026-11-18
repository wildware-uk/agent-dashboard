// The real stylesheet, so "whose card is this" is measured rather than asserted
// by class name.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import PostCard from './PostCard.svelte';
import { aMessage, aReaction, fakeActions } from './testing';

/**
 * A card for something said straight into the feed (migration 014).
 *
 * The case that matters most here is the one that was missing: an agent's note
 * with no anchor. Those were filed against the project and rendered nowhere, so
 * an agent could answer its owner and never be heard.
 */
const noreply = () => Promise.resolve();

describe('whose post it is', () => {
	it('says "You" for the owner, with the accent rail', async () => {
		const screen = render(PostCard, {
			post: aMessage({ id: 'm1', author: 'human', updateId: null, taskId: null }),
			onreply: noreply
		});

		await expect.element(screen.getByText('You')).toBeVisible();
		expect(document.querySelector('[data-post][data-mine="true"]')).not.toBeNull();
	});

	it('names the agent, and does not dress its note up as the owner’s', async () => {
		const screen = render(PostCard, {
			post: aMessage({ id: 'm1', author: 'agent:a1', updateId: null, taskId: null }),
			agentNames: { a1: 'scout' },
			onreply: noreply
		});

		await expect.element(screen.getByText('scout')).toBeVisible();
		expect(document.querySelector('[data-post][data-mine="true"]')).toBeNull();
	});
});

/**
 * What a post's card can do, and the bug that proved it could not.
 *
 * The owner: "I can't react to posts, only comments" — and, on the project
 * whose feed is mostly posts, "I can't react to anything on this project". One
 * cause: the timeline handed this card somewhere to upload images and nothing
 * to write with, so every control that needs the action client was dead.
 */
describe('the controls on a post', () => {
	it('offers a reaction on the post itself', async () => {
		const screen = render(PostCard, {
			post: aMessage({ id: 'm1', author: 'human', updateId: null, taskId: null }),
			onreply: noreply,
			actions: fakeActions().actions
		});

		await expect.element(screen.getByRole('button', { name: 'Add a reaction' })).toBeVisible();
	});

	it('offers one on each reply under it too', async () => {
		render(PostCard, {
			post: aMessage({ id: 'm1', author: 'human', updateId: null, taskId: null }),
			replies: [aMessage({ id: 'm2', author: 'agent:a1', updateId: null, replyTo: 'm1' })],
			replyReactions: { m2: [aReaction({ messageId: 'm2', actor: 'agent:a1' })] },
			onreply: noreply,
			actions: fakeActions().actions
		});

		// One for the post, one for the reply.
		expect(document.querySelectorAll('[aria-label="Add a reaction"]')).toHaveLength(2);
	});

	it('reacts as the owner when the chip is tapped', async () => {
		const fake = fakeActions();
		const screen = render(PostCard, {
			post: aMessage({ id: 'm1', author: 'human', updateId: null, taskId: null }),
			postReactions: [aReaction({ id: 'r1', messageId: 'm1', actor: 'human', emoji: '👍' })],
			onreply: noreply,
			actions: fake.actions
		});

		await screen.getByRole('button', { name: '👍 from You' }).click();

		expect(fake.calls).toContainEqual({ name: 'react', args: ['m1', '👍', undefined] });
	});

	it('shows no controls at all without an action client', async () => {
		render(PostCard, {
			post: aMessage({ id: 'm1', author: 'human', updateId: null, taskId: null }),
			onreply: noreply
		});

		expect(document.querySelector('[aria-label="Add a reaction"]')).toBeNull();
	});
});

/**
 * The controls every card has, on a post (migration 034).
 *
 * The owner: "let me pin my own messages." A post could be deleted and nothing
 * else — no pin, because pinning was written into the update card.
 */
describe('the owner controls on a post', () => {
	it('pins it, naming the card rather than a kind-specific endpoint', async () => {
		const acts = fakeActions();
		const screen = render(PostCard, {
			post: aMessage({ id: 'm4', author: 'human', updateId: null, taskId: null }),
			actions: acts.actions,
			onreply: async () => {}
		});

		await screen.getByRole('button', { name: 'Pin post' }).click();

		expect(acts.calls).toEqual([{ name: 'pinCard', args: ['message', 'm4', true] }]);
	});

	it('offers to unpin one that is already pinned', async () => {
		const acts = fakeActions();
		const screen = render(PostCard, {
			post: aMessage({ id: 'm4', author: 'human', updateId: null, taskId: null, pinned: true }),
			actions: acts.actions,
			onreply: async () => {}
		});

		await screen.getByRole('button', { name: 'Unpin post' }).click();

		expect(acts.calls).toEqual([{ name: 'pinCard', args: ['message', 'm4', false] }]);
	});

	it('still asks before deleting, and says what goes with it', async () => {
		const acts = fakeActions();
		const screen = render(PostCard, {
			post: aMessage({ id: 'm4', author: 'human', updateId: null, taskId: null }),
			replies: [aMessage({ id: 'm5', replyTo: 'm4' })],
			actions: acts.actions,
			onreply: async () => {},
			ondeletepost: async () => {}
		});

		await screen.getByRole('button', { name: 'Delete post' }).click();

		await expect.element(screen.getByText('Delete this post and its reply?')).toBeInTheDocument();
	});
});

/**
 * A post that reached nobody (design §7).
 *
 * The owner: "when a message isn't delivered yet, hold a red icon saying it
 * wasn't delivered to an agent."
 */
describe('a post nothing received', () => {
	it('says so in red on the owner`s own post', async () => {
		const screen = render(PostCard, {
			post: aMessage({
				id: 'm9',
				author: 'human',
				updateId: null,
				taskId: null,
				createdAt: Date.now() - 60_000
			}),
			onreply: async () => {}
		});

		expect(screen.container.querySelector('[data-ack-undelivered]')).not.toBeNull();
	});

	it('says nothing about a card that is marked as work', async () => {
		const screen = render(PostCard, {
			post: aMessage({
				id: 'm9',
				author: 'human',
				updateId: null,
				taskId: null,
				status: 'todo',
				createdAt: Date.now() - 60_000
			}),
			onreply: async () => {}
		});

		// Its state says where it has got to, which is a better answer than
		// whether a delivery row exists.
		expect(screen.container.querySelector('[data-ack-undelivered]')).toBeNull();
	});
});
