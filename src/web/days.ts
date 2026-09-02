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

/**
 * How long a pending request has left, for the card that is asking.
 *
 * Coarse on purpose — minutes, then hours — because the number is context for a
 * decision rather than a countdown: an owner reading "expires in 42m" knows they
 * have time, and a second-by-second clock would be a card that never stops
 * re-rendering. Computed once per render for the same reason.
 */
export function expiryLabel(expiresAt: number, now: number = Date.now()): string {
	const left = expiresAt - now;
	if (left <= 0) return 'expired';

	const minutes = Math.floor(left / 60_000);
	if (minutes < 1) return 'expires in under a minute';
	if (minutes < 60) return `expires in ${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `expires in ${hours}h` : `expires in ${hours}h ${rest}m`;
}

/**
 * How long ago something happened, in words (design §7).
 *
 * A timeline is read as "what is happening", and a clock time makes the reader
 * do the arithmetic for that: `14:02` means nothing without knowing what time it
 * is now, and on a phone glanced at hours later it means less. "4m ago" is the
 * question the reader was actually asking.
 *
 * The exact instant is not lost — every caller puts it in a `title` and a
 * `datetime`, so hovering says `Tuesday 25 August 2026 at 14:02`, and a screen
 * reader or a copy-paste gets the real thing.
 *
 * Beyond a month it turns back into a date. "37d ago" is arithmetic again, and
 * by then the reader wants to know *when*, not *how long*.
 */
export function relativeLabel(at: number, now: number = Date.now()): string {
	const seconds = Math.round((now - at) / 1000);

	// A clock skewed a few seconds into the future is a fact of life on a phone,
	// and "in 3 seconds" on a card that has already been posted reads as a bug.
	if (seconds < 10) return 'now';
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	return absoluteLabel(at, { time: false });
}

/**
 * The full instant, for the tooltip behind a relative label.
 *
 * `en-GB` fixed rather than locale-derived, for the same reason {@link dayLabel}
 * fixes it: the server renders this string too, and a browser that formatted it
 * differently would be a hydration mismatch on every card.
 */
export function absoluteLabel(at: number, options: { time?: boolean } = {}): string {
	const date = new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	}).format(new Date(at));

	return options.time === false ? date : `${date} at ${timeLabel(at)}`;
}
