// The real stylesheet, so "whose card is this" is measured rather than asserted
// by class name.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import PostCard from './PostCard.svelte';
import { aMessage } from './testing';

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
