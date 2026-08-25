/**
 * Grouping the timeline by day (design §7).
 *
 * Pure functions over epoch milliseconds — the same unit `$db` stores — so the
 * server render and the browser agree on the grouping and hydration does not
 * have to reconcile a different set of headings.
 *
 * Days are *local* days: an update posted at 23:00 belongs to the day the owner
 * was living through, not to whatever UTC thought at the time.
 */

/** One day of the timeline. */
export type DayGroup<Item> = {
	/** Stable `YYYY-MM-DD` key for `{#each}`, so a day is never remounted. */
	key: string;
	/** "Today", "Yesterday", or the written-out date. */
	label: string;
	items: Item[];
};

/** Anything with a creation instant can be grouped. */
export type Dated = { createdAt: number };

const pad = (value: number) => String(value).padStart(2, '0');

/** The local calendar day an instant falls in, as `YYYY-MM-DD`. */
export function dayKey(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A heading for a day, relative to now.
 *
 * "Today" and "Yesterday" cover almost everything an owner looks at, and are
 * worth the special case: a date is something you have to decode, where those
 * two are read. Older days are spelled out — `en-GB`, deliberately fixed rather
 * than locale-derived, so the server and the browser cannot disagree about the
 * heading and cause a hydration mismatch.
 */
export function dayLabel(at: number, now: number = Date.now()): string {
	const key = dayKey(at);
	if (key === dayKey(now)) return 'Today';
	if (key === dayKey(now - 86_400_000)) return 'Yesterday';

	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: sameYear ? undefined : 'numeric'
	}).format(new Date(at));
}

/** A clock time for one card. */
export function timeLabel(at: number): string {
	return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
		new Date(at)
	);
}

/**
 * Split an already-ordered timeline into day groups, preserving its order.
 *
 * The input order is the output order: this does not sort, because the server
 * has already decided what "newest first" means (by `seq`, not by timestamp) and
 * re-sorting here would let a card with a skewed clock jump the queue.
 */
export function groupByDay<Item extends Dated>(
	items: Item[],
	now: number = Date.now()
): DayGroup<Item>[] {
	const groups: DayGroup<Item>[] = [];
	for (const item of items) {
		const key = dayKey(item.createdAt);
		const last = groups.at(-1);
		if (last && last.key === key) last.items.push(item);
		else groups.push({ key, label: dayLabel(item.createdAt, now), items: [item] });
	}
	return groups;
}
