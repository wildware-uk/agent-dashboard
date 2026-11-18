import { describe, expect, it } from 'vitest';
import { STATUSES, isOpen, statusLook } from './status';

/**
 * What a card's work state looks like (migration 035).
 *
 * The owner: "agents can mark a card in the feed as a task, and update the
 * status of the card, in progress, done, blocked etc."
 */
describe('drawing a work state', () => {
	it('names every state a card can be in', () => {
		expect(STATUSES.map((status) => statusLook(status)?.label)).toEqual([
			'To do',
			'In progress',
			'Blocked',
			'Done',
			'Cancelled'
		]);
	});

	it('draws nothing for a card nobody marked, which is most of them', () => {
		expect(statusLook(null)).toBe(null);
		expect(statusLook(undefined)).toBe(null);
		expect(statusLook('')).toBe(null);
	});

	it('draws nothing for a word it does not know, rather than an empty chip', () => {
		// A state from a newer server than this tab: better a card with no chip
		// than a chip with no colour and no label.
		expect(statusLook('shipped')).toBe(null);
	});

	it('knows which states mean the work is still going', () => {
		expect(STATUSES.filter(isOpen)).toEqual(['todo', 'in_progress', 'blocked']);
	});
});
