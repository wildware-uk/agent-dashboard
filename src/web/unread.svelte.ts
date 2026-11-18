/**
 * How many comments on a card the reader has not looked at yet (design §7).
 *
 * The owner: "add a badge of how many new unread comments on a card."
 *
 * ## Why this is in the browser
 *
 * For the same reason folding and filtering are (`collapse.svelte.ts`): it is a
 * fact about *reading*, not about what happened. Two tabs must agree on what an
 * agent said; they need not agree on what the person at this desk has read. It
 * is also the state that a refetch would destroy — the timeline replaces rows by
 * id whenever anything is published, so a flag stored on the row would reset
 * every time somebody reacted to something.
 *
 * ## What counts as unread
 *
 * A comment somebody *else* wrote, after the last time this browser saw the
 * card's thread. The owner's own replies never count: they wrote them.
 *
 * A card this browser has never seen is not a pile of unread comments either —
 * it is a card nobody has looked at yet, and badging every card in the feed on
 * a new laptop would make the badge mean nothing. So the first sight of a card
 * {@link ReadComments.seed}s a quiet mark at its newest comment, and everything
 * after that is genuinely new.
 *
 * Every read and write is wrapped: a private window, cleared site data or
 * storage switched off all throw on access, and a feed that failed to render
 * because it could not remember a badge would be a bad trade.
 */

/** Where the marks live. Versioned, so a change of shape cannot half-load. */
export const READ_KEY = 'agent-dashboard:read-comments:v1';

/**
 * How many cards are remembered, newest mark first.
 *
 * A cap rather than everything: this grows with every card the owner scrolls
 * past, and a year of that is a list nobody reads carried into every page load.
 * Forgetting the oldest reads as an ancient card badging once more, which is the
 * cheapest possible way to be wrong.
 */
export const READ_MAX = 500;

/** The little a comment and this module have in common. */
export type Comment = { createdAt: number; author: string };

type Marks = Record<string, number>;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function browserStorage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		// Accessing the property itself throws in some contexts.
		return null;
	}
}

/** The marks in a stored value, or none if it is missing or unreadable. */
export function parseMarks(raw: string | null): Marks {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const marks: Marks = {};
		for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof at === 'number' && Number.isFinite(at)) marks[id] = at;
		}
		return marks;
	} catch {
		// Somebody else's key, or a half-written value. Not worth a crash.
		return {};
	}
}

/** The newest comment in a thread, or 0 for a thread with none. */
export function newestAt(comments: readonly Comment[]): number {
	let newest = 0;
	for (const comment of comments) if (comment.createdAt > newest) newest = comment.createdAt;
	return newest;
}

/**
 * The marks this browser is reading with.
 *
 * A class rather than a module-level value so a component test can hand it a
 * storage of its own, and so two instances cannot quietly share state.
 */
export class ReadComments {
	private marks = $state<Marks>({});
	private readonly storage: Storage | null;

	constructor(storage: Storage | null = browserStorage()) {
		this.storage = storage;
		try {
			this.marks = parseMarks(this.storage?.getItem(READ_KEY) ?? null);
		} catch {
			this.marks = {};
		}
	}

	/**
	 * How many comments on this card are new to the reader.
	 *
	 * Zero for a card nobody has seeded yet, which is the first-visit case: see
	 * the note at the top of this file for why that is not the same as "all of
	 * them".
	 */
	unread(cardId: string, comments: readonly Comment[]): number {
		const mark = this.marks[cardId];
		if (mark === undefined) return 0;
		let count = 0;
		for (const comment of comments) {
			if (comment.author !== 'human' && comment.createdAt > mark) count += 1;
		}
		return count;
	}

	/** Quietly mark a card this browser has never met, without badging it. */
	seed(cardId: string, comments: readonly Comment[]): void {
		if (this.marks[cardId] !== undefined) return;
		this.write(cardId, newestAt(comments));
	}

	/** The reader has looked at this card: nothing on it is new any more. */
	markRead(cardId: string, comments: readonly Comment[]): void {
		const newest = newestAt(comments);
		if ((this.marks[cardId] ?? -1) >= newest) return;
		this.write(cardId, newest);
	}

	/** What is remembered, for a test and for the cap. */
	get size(): number {
		return Object.keys(this.marks).length;
	}

	private write(cardId: string, at: number): void {
		const marks = { ...this.marks, [cardId]: at };
		this.marks = capped(marks);
		try {
			this.storage?.setItem(READ_KEY, JSON.stringify(this.marks));
		} catch {
			// Not remembered, which is the right failure: the badge still clears on
			// the page in front of them.
		}
	}
}

/** The newest {@link READ_MAX} marks, so the list cannot grow for ever. */
function capped(marks: Marks): Marks {
	const ids = Object.keys(marks);
	if (ids.length <= READ_MAX) return marks;
	return Object.fromEntries(
		ids
			.sort((left, right) => marks[right] - marks[left])
			.slice(0, READ_MAX)
			.map((id) => [id, marks[id]])
	);
}
