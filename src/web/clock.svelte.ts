/**
 * One ticking clock for every relative timestamp on the page (design §7).
 *
 * "4m ago" is only true for a minute, so something has to move — and the thing
 * that must *not* happen is fifty cards each holding their own interval. One
 * timer, refcounted by the components reading it, is the same shape the presence
 * rail already uses for the same reason (`presence.svelte.ts`).
 *
 * It stops when the last reader unmounts and when the tab is hidden: a
 * background tab redrawing timestamps nobody is looking at is pure battery, and
 * the value is corrected the moment it comes back because the getter reads the
 * real clock on the way in.
 */

/** How often the labels move. A second is what "12s ago" needs to be honest. */
export const TICK_MS = 1_000;

export type ClockOptions = {
	/** Injected by tests, which drive their own time. */
	clock?: () => number;
	tickMs?: number;
};

/**
 * The shared clock.
 *
 * Read `now` in a component and it re-renders as the clock moves; call `hold()`
 * on mount and the returned function on unmount.
 */
export class Clock {
	/** The current instant, as far as anything rendering a label is concerned. */
	now = $state(0);

	private ticker: ReturnType<typeof setInterval> | undefined;
	private holders = 0;
	private readonly clock: () => number;
	private readonly tickMs: number;
	private readonly onVisibility = () => this.sync();

	constructor(options: ClockOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.tickMs = options.tickMs ?? TICK_MS;
		this.now = this.clock();
	}

	/** How many components are keeping the clock running. Exists to prove no leaks. */
	get readers(): number {
		return this.holders;
	}

	/** Take a hold. The first one starts the timer; the returned call releases it. */
	hold(): () => void {
		this.holders += 1;
		if (this.holders === 1) this.start();

		let held = true;
		return () => {
			if (!held) return;
			held = false;
			this.holders -= 1;
			if (this.holders === 0) this.stop();
		};
	}

	/** Jump to the real instant now, whatever the timer has been doing. */
	sync(): void {
		this.now = this.clock();
		if (typeof document === 'undefined') return;
		// A hidden tab's timer is throttled to near-uselessness anyway, so it is
		// dropped outright and restarted on the way back.
		if (document.visibilityState === 'hidden') this.pause();
		else if (this.holders > 0 && this.ticker === undefined) this.run();
	}

	private start(): void {
		this.now = this.clock();
		this.run();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.onVisibility);
		}
	}

	private run(): void {
		this.ticker = setInterval(() => (this.now = this.clock()), this.tickMs);
	}

	private pause(): void {
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private stop(): void {
		this.pause();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.onVisibility);
		}
	}
}

let shared: Clock | null = null;

/**
 * The page's clock.
 *
 * Built on first use rather than at module scope: this module is imported during
 * the server render, and a clock created there would be one object shared by
 * every request, ticking for nobody.
 */
export function clock(): Clock {
	return (shared ??= new Clock());
}
