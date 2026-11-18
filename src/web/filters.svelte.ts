/**
 * What the feed is showing (design §7).
 *
 * The owner: "add filtering on dashboards, filter cards by work status, etc."
 *
 * A filter is a reading preference, so it lives in the browser exactly as a
 * folded card does (`collapse.svelte.ts`): the same person can reasonably be
 * looking at open work on the laptop and the whole feed on the phone, and
 * neither is wrong. It survives a reload because a filter you have to set again
 * every time is one you stop using.
 *
 * It filters what is *on the page* rather than asking the server for a narrower
 * feed. That is a deliberate limit and worth stating: the timeline holds the
 * most recent page of cards, so "Blocked" shows the blocked cards among those,
 * not every blocked card ever. Scrolling loads more and they appear. Making it a
 * query would mean a filter that changes what "load older" means, and a feed
 * that pages differently depending on a chip is harder to reason about than one
 * that always shows the same cards with some hidden.
 */
import { isOpen, STATUSES, type CardStatus } from './status';

/** What a card must be for the feed to show it. */
export type Filter = 'all' | 'work' | CardStatus;

/** The chips, in the order they are offered. */
export const FILTERS: readonly { id: Filter; label: string }[] = [
	{ id: 'all', label: 'Everything' },
	{ id: 'work', label: 'Open work' },
	{ id: 'todo', label: 'To do' },
	{ id: 'in_progress', label: 'In progress' },
	{ id: 'blocked', label: 'Blocked' },
	{ id: 'done', label: 'Done' }
];

/** Where the choice is remembered. Versioned, as the folded set is. */
export const FILTER_KEY = 'agent-dashboard:filter:v1';

/** Whether a stored value is still one of the filters this version offers. */
export function parseFilter(raw: string | null): Filter {
	if (raw === 'all' || raw === 'work') return raw;
	return (STATUSES as readonly string[]).includes(raw ?? '') ? (raw as CardStatus) : 'all';
}

/**
 * Does this card survive the filter?
 *
 * `all` keeps everything, including the cards nobody has marked — the feed is
 * still a feed. `work` is the useful one: everything that is not finished, which
 * is the question "what is outstanding" asked of the page rather than of a
 * separate board.
 */
export function matches(filter: Filter, status: string | null | undefined): boolean {
	if (filter === 'all') return true;
	if (filter === 'work') return isOpen(status);
	return status === filter;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function browserStorage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/**
 * The filter this browser is reading with.
 *
 * A class rather than a module-level value so a component test can hand it a
 * storage of its own, and so two instances cannot quietly share state.
 */
export class Filtering {
	current = $state<Filter>('all');
	private readonly storage: Storage | null;

	constructor(storage: Storage | null = browserStorage()) {
		this.storage = storage;
		try {
			this.current = parseFilter(this.storage?.getItem(FILTER_KEY) ?? null);
		} catch {
			// A private window, or storage switched off. The feed still works.
			this.current = 'all';
		}
	}

	set(filter: Filter): void {
		this.current = filter;
		try {
			this.storage?.setItem(FILTER_KEY, filter);
		} catch {
			// Not remembered, which is the right failure: the filter still applies
			// to the page in front of them.
		}
	}

	/** Whether a card survives what is currently selected. */
	keeps(status: string | null | undefined): boolean {
		return matches(this.current, status);
	}
}
