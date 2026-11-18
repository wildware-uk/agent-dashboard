/**
 * Which cards the owner has folded away (design §7).
 *
 * The owner: "allow me to collapse a card, which will hide the replies, and
 * shorten the message content, if its too long." Their feed is long reports and
 * long threads — that is what the product is for — and the cost of that is a
 * page you have to scroll past things you have already read.
 *
 * ## Why this is in the browser and not in the database
 *
 * Everything else on this dashboard is server state, deliberately: two tabs
 * must not disagree about what an agent said. Collapsing is the opposite kind of
 * fact. It is about *reading*, not about what happened — the same person may
 * reasonably have a card folded on the laptop they are working at and open on
 * the phone they are checking, and neither is wrong. So it lives in
 * `localStorage`, which is per browser by construction.
 *
 * It is also the one piece of state here that must survive a refetch. The
 * timeline replaces rows by id whenever anything is published (design §4), so a
 * collapsed flag stored on the row would spring open every time somebody
 * reacted to something.
 *
 * Every read and write is wrapped: a private window, cleared site data, or a
 * browser set to block storage all throw on access, and a feed that fails to
 * render because it could not remember a chevron would be a bad trade.
 */

/** Where the set lives. Versioned, so a change of shape cannot half-load. */
export const COLLAPSED_KEY = 'agent-dashboard:collapsed:v1';

/**
 * How many cards are remembered, newest first.
 *
 * A cap rather than everything, because this grows without limit otherwise: an
 * owner who collapses ten cards a day for a year would carry a list nobody
 * reads into every page load. The oldest are forgotten, which reads as a card
 * quietly coming back open long after anybody cared.
 */
export const COLLAPSED_MAX = 500;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function browserStorage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		// Accessing the property itself throws in some contexts.
		return null;
	}
}

/** The ids in a stored value, or none if it is missing or unreadable. */
export function parseCollapsed(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === 'string').slice(0, COLLAPSED_MAX);
	} catch {
		// Somebody else's key, or a half-written value. Not worth a crash.
		return [];
	}
}

/**
 * The cards this browser has folded away.
 *
 * A class rather than a module-level set so a component test can hand it a
 * storage of its own, and so two instances cannot quietly share state.
 */
export class Collapsed {
	/** Newest first, so the cap forgets the ones collapsed longest ago. */
	private ids = $state<string[]>([]);
	private readonly storage: Storage | null;

	constructor(storage: Storage | null = browserStorage()) {
		this.storage = storage;
		try {
			this.ids = parseCollapsed(this.storage?.getItem(COLLAPSED_KEY) ?? null);
		} catch {
			this.ids = [];
		}
	}

	/** Whether this card is folded away right now. */
	has(id: string): boolean {
		return this.ids.includes(id);
	}

	/** Fold it, or open it. @returns whether it is collapsed afterwards. */
	set(id: string, collapsed: boolean): boolean {
		const without = this.ids.filter((held) => held !== id);
		this.ids = collapsed ? [id, ...without].slice(0, COLLAPSED_MAX) : without;
		this.save();
		return collapsed;
	}

	/** The usual control: a click means "the other one". */
	toggle(id: string): boolean {
		return this.set(id, !this.has(id));
	}

	private save(): void {
		try {
			this.storage?.setItem(COLLAPSED_KEY, JSON.stringify(this.ids));
		} catch {
			// Out of quota, or storage disabled. The fold still works for this page;
			// it simply will not be remembered, which is the right failure.
		}
	}
}
