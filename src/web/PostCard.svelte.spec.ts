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
