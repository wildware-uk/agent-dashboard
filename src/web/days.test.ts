import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, groupByDay } from './days';

/** Local-time midnight-ish instants, so the grouping is tested in any timezone. */
const at = (year: number, month: number, day: number, hour = 12) =>
	new Date(year, month - 1, day, hour).getTime();

const NOW = at(2026, 8, 25);

describe('dayKey', () => {
	it('is the same for two instants on the same local day', () => {
		expect(dayKey(at(2026, 8, 25, 0))).toBe(dayKey(at(2026, 8, 25, 23)));
	});

	it('differs across midnight', () => {
		expect(dayKey(at(2026, 8, 25, 23))).not.toBe(dayKey(at(2026, 8, 26, 0)));
	});
});

describe('dayLabel', () => {
	it('names today and yesterday, which is what most of the timeline is', () => {
		expect(dayLabel(at(2026, 8, 25, 9), NOW)).toBe('Today');
		expect(dayLabel(at(2026, 8, 24, 9), NOW)).toBe('Yesterday');
	});

	it('names an older day in this year without the year', () => {
		expect(dayLabel(at(2026, 8, 20), NOW)).toBe('Thursday 20 August');
	});

	it('includes the year once it is a different one', () => {
		expect(dayLabel(at(2025, 12, 31), NOW)).toBe('Wednesday, 31 December 2025');
	});
});

describe('groupByDay', () => {
	const items = [
		{ id: 'c', createdAt: at(2026, 8, 25, 16) },
		{ id: 'b', createdAt: at(2026, 8, 25, 9) },
		{ id: 'a', createdAt: at(2026, 8, 24, 17) }
	];

	it('groups a newest-first timeline into newest-first days', () => {
		const groups = groupByDay(items, NOW);

		expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday']);
		expect(groups[0].items.map((item) => item.id)).toEqual(['c', 'b']);
		expect(groups[1].items.map((item) => item.id)).toEqual(['a']);
	});

	it('keys each group stably, so a re-render does not remount the day', () => {
		const groups = groupByDay(items, NOW);

		expect(groups[0].key).toBe(dayKey(items[0].createdAt));
	});

	it('has nothing to show for an empty timeline', () => {
		expect(groupByDay([], NOW)).toEqual([]);
	});
});
