/**
 * Which cards have just moved (design §7).
 *
 * The owner: "cards flow to the top when they are updated."
 *
 * The sliding itself is Svelte's FLIP animation on the keyed feed rows — that
 * handles a card changing place *within* a day group. This is the other half:
 * the card is marked for a moment afterwards, so a reader whose eyes were
 * somewhere else can still tell which one moved, and so a card that jumped
 * between two groups (where FLIP cannot follow it) is not silent.
 *
 * It compares against what it last saw rather than listening for events: the
 * feed already recomputes "when did this card last have something happen"
 * (`activity.ts`) on every refetch, and a number going up is exactly the thing
 * worth showing. A card seen for the first time is not a bump — it is a card
 * arriving, which has its own animation.
 */
import { SvelteSet } from 'svelte/reactivity';
import { BUMP_MS } from './motion';

export class Bumps {
	/** The activity time this store last saw per card. Plain data: the input. */
	private readonly seen: Record<string, number> = {};
	/** The cards currently marked. Reactive, because the cards read it. */
	private readonly marked = new SvelteSet<string>();
	private readonly timers: Record<string, ReturnType<typeof setTimeout>> = {};
	private readonly holdMs: number;

	constructor(holdMs: number = BUMP_MS) {
		this.holdMs = holdMs;
	}

	/** Tell the store where a card is up to. Marks it if that moved forward. */
	note(id: string, activityAt: number): void {
		const before = this.seen[id];
		this.seen[id] = activityAt;
		if (before === undefined || activityAt <= before) return;
		this.mark(id);
	}

	/** Is this card wearing the marker right now? */
	has(id: string): boolean {
		return this.marked.has(id);
	}

	/** Drop every timer. For a component that is going away. */
	stop(): void {
		for (const timer of Object.values(this.timers)) clearTimeout(timer);
		for (const id of Object.keys(this.timers)) delete this.timers[id];
	}

	private mark(id: string): void {
		const running = this.timers[id];
		if (running) clearTimeout(running);
		this.marked.add(id);
		this.timers[id] = setTimeout(() => {
			delete this.timers[id];
			this.marked.delete(id);
		}, this.holdMs);
	}
}
