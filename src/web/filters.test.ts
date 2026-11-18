import { describe, expect, it } from 'vitest';
import { FILTERS, FILTER_KEY, Filtering, matches, parseFilter } from './filters.svelte';

/**
 * What the feed is showing (design §7).
 *
 * The owner: "add filtering on dashboards, filter cards by work status, etc."
 */
function fakeStorage(initial: Record<string, string> = {}) {
	const held: Record<string, string> = { ...initial };
	return {
		held,
		getItem: (key: string) => held[key] ?? null,
		setItem: (key: string, value: string) => {
			held[key] = value;
		}
	};
}

describe('what a filter keeps', () => {
	it('keeps everything by default, because a feed is a feed', () => {
		expect(matches('all', null)).toBe(true);
		expect(matches('all', 'done')).toBe(true);
	});

	it('keeps work that is not finished', () => {
		expect(['todo', 'in_progress', 'blocked'].every((s) => matches('work', s))).toBe(true);
		expect(matches('work', 'done')).toBe(false);
		expect(matches('work', 'cancelled')).toBe(false);
		// An ordinary card is not outstanding work.
		expect(matches('work', null)).toBe(false);
	});

	it('keeps one state when one is asked for', () => {
		expect(matches('blocked', 'blocked')).toBe(true);
		expect(matches('blocked', 'todo')).toBe(false);
	});

	it('offers everything, open work, and the four states worth asking about', () => {
		expect(FILTERS.map((filter) => filter.id)).toEqual([
			'all',
			'work',
			'todo',
			'in_progress',
			'blocked',
			'done'
		]);
	});
});

describe('remembering the choice', () => {
	it('writes it down, so a reload reads the same feed', () => {
		const storage = fakeStorage();
		new Filtering(storage).set('blocked');

		expect(storage.held[FILTER_KEY]).toBe('blocked');
		expect(new Filtering(storage).current).toBe('blocked');
	});

	it('falls back to everything for a value it does not know', () => {
		// A filter from a newer version of the page, or a half-written value.
		expect(parseFilter('shipped')).toBe('all');
		expect(parseFilter(null)).toBe('all');
	});

	it('still filters where storage is unusable, which is a real browser state', () => {
		const throwing = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		};
		const filtering = new Filtering(throwing);

		expect(filtering.current).toBe('all');
		expect(() => filtering.set('todo')).not.toThrow();
		expect(filtering.keeps('todo')).toBe(true);
		expect(filtering.keeps('done')).toBe(false);
	});
});
