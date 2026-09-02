import { describe, expect, it } from 'vitest';
import { absoluteLabel, dayKey, dayLabel, expiryLabel, groupByDay, relativeLabel } from './days';

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

describe('how long a request has left', () => {
	const minutes = (count: number) => NOW + count * 60_000;

	it('counts down in minutes for the first hour', () => {
		expect(expiryLabel(minutes(42), NOW)).toBe('expires in 42m');
	});

	it('switches to hours once there are more than sixty minutes left', () => {
		expect(expiryLabel(minutes(65), NOW)).toBe('expires in 1h 5m');
		expect(expiryLabel(minutes(120), NOW)).toBe('expires in 2h');
	});

	it('says "under a minute" rather than "0m", which reads as expired', () => {
		expect(expiryLabel(NOW + 30_000, NOW)).toBe('expires in under a minute');
	});

	it('says so once the deadline has passed', () => {
		expect(expiryLabel(NOW, NOW)).toBe('expired');
		expect(expiryLabel(minutes(-5), NOW)).toBe('expired');
	});
});

/**
 * How long ago, in words (design §7).
 *
 * A clock time makes the reader work out what it means; "4m ago" is the question
 * they were asking. The exact instant is never lost — it goes in the title and
 * the `datetime`, which is what {@link absoluteLabel} is for.
 */
describe('relativeLabel', () => {
	const ago = (seconds: number) => relativeLabel(NOW - seconds * 1000, NOW);

	it('says "now" for something that just happened', () => {
		expect(ago(0)).toBe('now');
		expect(ago(9)).toBe('now');
	});

	it('counts seconds, then minutes, then hours, then days', () => {
		expect(ago(12)).toBe('12s ago');
		expect(ago(59)).toBe('59s ago');
		expect(ago(60)).toBe('1m ago');
		expect(ago(59 * 60)).toBe('59m ago');
		expect(ago(60 * 60)).toBe('1h ago');
		expect(ago(23 * 3600)).toBe('23h ago');
		expect(ago(24 * 3600)).toBe('1d ago');
		expect(ago(29 * 24 * 3600)).toBe('29d ago');
	});

	it('turns back into a date once the arithmetic stops helping', () => {
		// "37d ago" is arithmetic again; by then the reader wants to know when.
		expect(ago(37 * 24 * 3600)).toBe('Sunday, 19 July 2026');
	});

	it('says "now" rather than counting into the future on a skewed clock', () => {
		// A phone a few seconds fast is a fact of life, and "in 3 seconds" on a
		// card that has already been posted reads as a bug.
		expect(relativeLabel(NOW + 3_000, NOW)).toBe('now');
	});

	it('rounds to the nearest second rather than truncating', () => {
		expect(relativeLabel(NOW - 11_600, NOW)).toBe('12s ago');
	});
});

describe('absoluteLabel', () => {
	it('spells out the instant a relative label is hiding', () => {
		expect(absoluteLabel(at(2026, 8, 25, 14))).toBe('Tuesday, 25 August 2026 at 14:00');
	});

	it('drops the clock time when only the date is wanted', () => {
		expect(absoluteLabel(at(2026, 8, 25, 14), { time: false })).toBe('Tuesday, 25 August 2026');
	});
});
