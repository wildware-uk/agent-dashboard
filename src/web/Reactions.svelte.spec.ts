// The real stylesheet, so "mine" is measured rather than asserted by class name.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Reactions from './Reactions.svelte';
import { aReaction } from './testing';

/**
 * Reactions on a message (migration 024).
 *
 * The owner asked for "a nice simple way to allow quick communication", so what
 * is asserted here is that it reads at a glance and costs one tap: one chip per
 * emoji with a count, their own marked, and a click that toggles.
 */
describe('the chips', () => {
	it('groups the same emoji into one chip with a count', async () => {
		render(Reactions, {
			reactions: [
				aReaction({ id: 'r1', actor: 'human', emoji: '\u{1f44d}' }),
				aReaction({ id: 'r2', actor: 'agent:a1', emoji: '\u{1f44d}' }),
				aReaction({ id: 'r3', actor: 'agent:a1', emoji: '\u{1f440}' })
			],
			agentNames: { a1: 'scout' }
		});

		const chips = [...document.querySelectorAll('[data-reaction]')];
		expect(chips).toHaveLength(2);
		expect(chips[0]?.textContent).toContain('2');
	});

	it('marks the owner’s own, so "have I reacted" needs no counting', async () => {
		render(Reactions, {
			reactions: [
				aReaction({ id: 'r1', actor: 'human', emoji: '✅' }),
				aReaction({ id: 'r2', actor: 'agent:a1', emoji: '\u{1f440}' })
			]
		});

		expect(document.querySelector('[data-reaction="✅"][data-mine="true"]')).not.toBeNull();
		expect(document.querySelector('[data-reaction="\u{1f440}"][data-mine="true"]')).toBeNull();
	});

	it('says who reacted, for a count that does not say', async () => {
		const screen = render(Reactions, {
			reactions: [aReaction({ actor: 'agent:a1', emoji: '\u{1f440}' })],
			agentNames: { a1: 'scout' }
		});

		await expect
			.element(screen.getByRole('button', { name: '\u{1f440} from scout' }))
			.toBeVisible();
	});
});

describe('reacting', () => {
	it('toggles an existing chip with one tap', async () => {
		const tapped: string[] = [];
		const screen = render(Reactions, {
			reactions: [aReaction({ actor: 'human', emoji: '\u{1f44d}' })],
			onreact: (emoji: string) => {
				tapped.push(emoji);
				return Promise.resolve();
			}
		});

		await screen.getByRole('button', { name: '\u{1f44d} from You' }).click();

		expect(tapped).toEqual(['\u{1f44d}']);
	});

	it('offers a short picker rather than an emoji keyboard', async () => {
		const tapped: string[] = [];
		const screen = render(Reactions, {
			onreact: (emoji: string) => {
				tapped.push(emoji);
				return Promise.resolve();
			}
		});

		await screen.getByRole('button', { name: 'Add a reaction' }).click();
		await screen.getByRole('button', { name: 'React \u{1f440}' }).click();

		expect(tapped).toEqual(['\u{1f440}']);
	});

	it('renders read-only with nowhere to write to', async () => {
		render(Reactions, { reactions: [aReaction({ actor: 'agent:a1', emoji: '\u{1f440}' })] });

		expect(document.querySelector('[aria-label="Add a reaction"]')).toBeNull();
		expect(document.querySelector('[data-reaction]')).not.toBeNull();
	});

	it('says so when the write fails, and keeps the chip', async () => {
		const screen = render(Reactions, {
			reactions: [aReaction({ actor: 'human', emoji: '\u{1f44d}' })],
			onreact: () => Promise.reject(new Error('offline'))
		});

		await screen.getByRole('button', { name: '\u{1f44d} from You' }).click();

		await expect.element(screen.getByRole('alert')).toHaveTextContent('offline');
		expect(document.querySelector('[data-reaction]')).not.toBeNull();
	});
});
