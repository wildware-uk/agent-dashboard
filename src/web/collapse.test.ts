import { describe, expect, it } from 'vitest';
import { COLLAPSED_KEY, COLLAPSED_MAX, Collapsed, parseCollapsed } from './collapse.svelte';

/**
 * Which cards the owner has folded away (design §7).
 *
 * The owner: "allow me to collapse a card, which will hide the replies." It is
 * reading state rather than something that happened, so it lives in the browser
 * — but it has to survive a refetch, which is the whole reason it is a store
 * and not a flag on the row.
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

describe('remembering a fold', () => {
	it('folds a card and opens it again', () => {
		const collapsed = new Collapsed(fakeStorage());

		expect(collapsed.has('u1')).toBe(false);
		expect(collapsed.toggle('u1')).toBe(true);
		expect(collapsed.has('u1')).toBe(true);
		expect(collapsed.toggle('u1')).toBe(false);
		expect(collapsed.has('u1')).toBe(false);
	});

	it('writes it down, so a reload finds the same cards folded', () => {
		const storage = fakeStorage();
		new Collapsed(storage).set('u1', true);

		expect(new Collapsed(storage).has('u1')).toBe(true);
		expect(JSON.parse(storage.held[COLLAPSED_KEY])).toEqual(['u1']);
	});

	it('is idempotent, so a double click is one fold', () => {
		const collapsed = new Collapsed(fakeStorage());
		collapsed.set('u1', true);
		collapsed.set('u1', true);

		expect(collapsed.has('u1')).toBe(true);
	});

	it('forgets the oldest rather than growing without limit', () => {
		const storage = fakeStorage();
		const collapsed = new Collapsed(storage);
		for (let index = 0; index <= COLLAPSED_MAX; index += 1) collapsed.set(`u${index}`, true);

		// The first one folded is the first forgotten; the newest is kept.
		expect(collapsed.has('u0')).toBe(false);
		expect(collapsed.has(`u${COLLAPSED_MAX}`)).toBe(true);
	});

	it('renders a page even where storage is unusable, which is a real browser state', () => {
		// A private window, cleared site data, a browser set to block storage: the
		// accessor itself throws, and a feed that failed to draw because of a
		// chevron would be a bad trade.
		const throwing = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		};
		const collapsed = new Collapsed(throwing);

		expect(collapsed.has('u1')).toBe(false);
		expect(() => collapsed.set('u1', true)).not.toThrow();
		// It still works for this page; it simply will not be remembered.
		expect(collapsed.has('u1')).toBe(true);
	});
});

describe('reading what was stored', () => {
	it('takes the ids, and nothing else', () => {
		expect(parseCollapsed(JSON.stringify(['u1', 'u2']))).toEqual(['u1', 'u2']);
		expect(parseCollapsed(JSON.stringify(['u1', 7, null]))).toEqual(['u1']);
	});

	it('treats anything unreadable as nothing folded', () => {
		expect(parseCollapsed(null)).toEqual([]);
		expect(parseCollapsed('not json')).toEqual([]);
		expect(parseCollapsed('{"u1":true}')).toEqual([]);
	});
});
