/**
 * The task list store (design §5, §7).
 *
 * The same contract as the timeline and the rail, for the same reasons
 * (`src/http/README.md`):
 *
 * 1. **Events carry identifiers, not data.** `task.created` and `task.updated`
 *    know an id and a state, so an arrival is a *reason to refetch*, never a row
 *    to render. Refetching the whole (small) list and replacing it wholesale is
 *    what makes double delivery, replay and out-of-order frames harmless — and a
 *    claim that lands while the owner is looking at the list appear without a
 *    reload.
 * 2. **A snapshot is stamped with the seq it is good to**, so replayed frames at
 *    or below it are dropped rather than provoking a request storm.
 *
 * Two deliberate differences from the timeline. There is no paging and no "N
 * new" pill: a task list is short, it is read rather than scrolled, and a task
 * appearing at the top of a list of eight is not the same interruption as a card
 * appearing in a feed. And the list is replaced rather than reconciled by id,
 * because the server's answer *is* the answer — a task missing from it has been
 * paged out of the done tail, not silently deleted.
 *
 * It does not filter events by project, unlike the timeline. A scoped request
 * already returns only this project's tasks, and task events are rare — the
 * owner types them and a handful of agents claim them — so a refetch that
 * returns an identical list costs less than holding a second copy of the project
 * map in here to avoid it.
 */
import type { TaskState, TaskView, TasksSnapshot } from './types';
import type { Fetcher } from './timeline.svelte';
import {
	DirectLink,
	SharedStream,
	sharedStream,
	type OpenStream,
	type StreamMessage,
	type Subscription
} from './stream';

/** The events that change the list. */
const WATCHED = ['task.created', 'task.updated', 'resync'] as const;

/** How much the store knows about its connection. */
export type TasksStatus = 'idle' | 'live' | 'offline';

export type TasksOptions = {
	/** A project slug to scope every request to. Omit for every project's tasks. */
	project?: string | null;
	fetch?: Fetcher;
	/** The tab's one stream (design §4, #19). Defaults to the shared one. */
	stream?: SharedStream;
	/** Test seam: a stream of this store's own, over this opener. */
	openStream?: OpenStream;
	/** Coalescing hook: a burst of events becomes one request. Tests run it by hand. */
	schedule?: (run: () => void) => void;
};

/** The states that count as finished, in the order the owner reads them. */
const OVER: readonly TaskState[] = ['done', 'cancelled'];

export class Tasks {
	/** Every task the server sent, newest first. */
	items = $state<TaskView[]>([]);
	/** The newest event seq this state accounts for. */
	seq = $state(0);
	status = $state<TasksStatus>('idle');
	loading = $state(false);

	private hub: SharedStream | null;
	private held: Subscription | null = null;
	/**
	 * How many mounted components are holding this store.
	 *
	 * Refcounted rather than a boolean because the panel appears twice on a
	 * phone-sized page — once in the desktop rail, which stays mounted behind a
	 * `hidden xl:block`, and once in the drawer that makes the rail reachable on a
	 * phone (design §7). With a boolean, closing the drawer would unsubscribe the
	 * rail's copy too and the list would quietly stop being live.
	 */
	private holders = 0;
	private queued = false;
	private inFlight: Promise<void> | null = null;

	private readonly project: string | null;
	private readonly fetcher: Fetcher;
	private readonly schedule: (run: () => void) => void;
	private readonly listener = (event: StreamMessage) => this.receive(event);
	private readonly onOpen = () => {
		this.status = 'live';
	};
	private readonly onError = () => {
		// `EventSource` reconnects by itself; this only stops the panel implying it
		// is current while it is not.
		if (this.held) this.status = 'offline';
	};

	constructor(options: TasksOptions = {}) {
		this.project = options.project ?? null;
		this.fetcher = options.fetch ?? ((url) => fetch(url));
		this.hub =
			options.stream ??
			(options.openStream ? new SharedStream(new DirectLink(options.openStream)) : null);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
	}

	/** Waiting for somebody to pick it up. */
	get todo(): TaskView[] {
		return this.items.filter((task) => task.state === 'todo');
	}

	/** Being worked on right now. */
	get claimed(): TaskView[] {
		return this.items.filter((task) => task.state === 'claimed');
	}

	/**
	 * Over: finished, and withdrawn.
	 *
	 * Cancelled tasks are listed here rather than hidden. The owner cancelled
	 * them, so the useful thing to show is that they stayed cancelled — and a
	 * fourth column for them would be a column that is empty almost always.
	 */
	get done(): TaskView[] {
		return this.items.filter((task) => OVER.includes(task.state));
	}

	/** How much work is outstanding, for a heading that says so at a glance. */
	get openCount(): number {
		return this.todo.length + this.claimed.length;
	}

	/** Adopt a snapshot fetched or server-rendered elsewhere. */
	hydrate(snapshot: TasksSnapshot): void {
		this.apply(snapshot);
	}

	/** Take a hold on the tab's stream and read the list. Safe to call twice. */
	start(): void {
		this.holders += 1;
		if (this.holders > 1) return;

		const hub = (this.hub ??= sharedStream());
		this.held = hub.subscribe({
			types: WATCHED,
			listener: this.listener,
			onOpen: this.onOpen,
			onError: this.onError,
			cursor: this.seq
		});
		this.status = hub.connected ? 'live' : 'offline';

		this.scheduleRefresh();
	}

	/**
	 * Let go of the stream. Safe to call twice; the panel calls it on unmount.
	 *
	 * Only the last holder actually releases it, so one of two mounted panels
	 * going away leaves the other one live.
	 */
	stop(): void {
		if (this.holders > 0) this.holders -= 1;
		if (this.holders > 0) return;
		// A refetch queued a moment ago must not fire after the panel has gone.
		this.queued = false;
		// Only this store's hold: the connection outlives the panel if the timeline
		// is still reading it, and is closed by the hub if it is not.
		this.held?.close();
		this.held = null;
		this.status = 'idle';
	}

	/** Read the list now. Never two requests at once. */
	async refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight;

		this.inFlight = this.run();
		try {
			await this.inFlight;
		} finally {
			this.inFlight = null;
		}
	}

	private async run(): Promise<void> {
		this.loading = true;
		try {
			const snapshot = await this.read(this.url());
			if (snapshot) this.apply(snapshot);
		} finally {
			this.loading = false;
		}
	}

	/**
	 * The request URL.
	 *
	 * Assembled by hand rather than with `URLSearchParams`, which in a Svelte
	 * module is a reactivity trap (`svelte/prefer-svelte-reactivity`).
	 */
	private url(): string {
		return this.project === null
			? '/api/snapshot/tasks'
			: `/api/snapshot/tasks?project=${encodeURIComponent(this.project)}`;
	}

	private async read(url: string): Promise<TasksSnapshot | null> {
		try {
			const response = await this.fetcher(url);
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as TasksSnapshot;
		} catch {
			// Keep what we hold: an empty list would read as "no work", which is a
			// worse lie than a slightly old one.
			this.status = 'offline';
			return null;
		}
	}

	private apply(snapshot: TasksSnapshot): void {
		this.items = snapshot.tasks;
		this.seq = Math.max(this.seq, snapshot.seq);
	}

	private receive(event: StreamMessage): void {
		this.status = 'live';
		const frame = parse(event.data);
		if (!frame) return;

		// Already accounted for. Replay after a reconnect lands here, which is why
		// it costs nothing.
		if (frame.type !== 'resync' && frame.seq !== undefined && frame.seq <= this.seq) return;

		this.scheduleRefresh();
	}

	/** One refetch per burst of events. */
	private scheduleRefresh(): void {
		if (this.queued) return;
		this.queued = true;
		this.schedule(() => {
			if (!this.queued) return;
			this.queued = false;
			void this.refresh();
		});
	}
}

type Frame = { type: string; seq?: number };

/** A malformed frame is dropped, not thrown: one bad byte must not kill the list. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}
