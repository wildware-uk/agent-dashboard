/**
 * The live timeline store (design §4, §7).
 *
 * One object owns everything the shell renders and everything it knows about
 * the connection: the project list, the timeline, the "N new" buffer, and the
 * stream cursor. Components read it and call it; they do not fetch.
 *
 * Two rules from the transport shape all of it (see `src/http/README.md`):
 *
 * 1. **Events carry identifiers, not data.** `update.created` knows an id and
 *    nothing else, so an arrival is a *reason to refetch*, never a row to
 *    render. Refetching a small newest-first page and reconciling by id is what
 *    makes double delivery, replay and out-of-order frames all harmless.
 * 2. **A snapshot is stamped with the seq it is good to.** Anything at or below
 *    that seq is already in hand, so it is dropped rather than refetched — which
 *    is what stops the replay a reconnect delivers from causing a request storm.
 *
 * The one piece of UI policy that lives here rather than in a component: while
 * the reader is scrolled away from the top, arrivals are held in `pending`
 * instead of being inserted. That is what makes the "N new" pill honest — the
 * viewport cannot move, because nothing above the reader has changed.
 */
import type { ProjectView, SnapshotResponse, UpdateView } from './types';

/** The slice of `EventSource` this store uses. Injected, so tests need no server. */
export type StreamLike = {
	addEventListener(type: string, listener: (event: MessageEvent) => void): void;
	removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
	close(): void;
};

/** Just enough of `fetch`. The browser's own satisfies it. */
export type Fetcher = (url: string) => Promise<Response>;

/**
 * How much the store knows about its connection.
 *
 * `live` means "the stream is open as far as we can tell"; `offline` is set the
 * moment `EventSource` reports an error and cleared when it reconnects, so the
 * shell can say so rather than showing stale data as if it were current.
 */
export type TimelineStatus = 'idle' | 'live' | 'offline';

export type TimelineOptions = {
	/** A project slug to scope every request to. Omit for the whole timeline. */
	project?: string | null;
	/** Timeline page size. */
	limit?: number;
	fetch?: Fetcher;
	openStream?: (url: string) => StreamLike;
	/**
	 * Coalescing hook: runs a queued refetch. Defaults to a macrotask, so a burst
	 * of events in one tick becomes one request. Tests run it by hand.
	 */
	schedule?: (run: () => void) => void;
};

/** The events that change what the shell shows. */
const WATCHED = [
	'update.created',
	// An update the owner curated in place — a pin (design §7). Like every other
	// event it carries an identifier, so it is a reason to refetch and reconcile
	// by id, which is what replaces the row this page already renders.
	'update.updated',
	'update.deleted',
	'project.created',
	'project.updated',
	'resync'
] as const;

const DEFAULT_LIMIT = 50;

/** How many recent arrivals are remembered for the entry animation. */
const ARRIVED_MEMORY = 200;

function defaultFetch(url: string): Promise<Response> {
	return fetch(url);
}

export class Timeline {
	/** Sidebar order comes from the server: pinned first, then newest. */
	projects = $state<ProjectView[]>([]);
	/** Newest first. What the timeline renders. */
	items = $state<UpdateView[]>([]);
	/** Arrivals held back while the reader is scrolled away from the top. */
	pending = $state<UpdateView[]>([]);
	/** The newest event seq this state accounts for. */
	seq = $state(0);
	status = $state<TimelineStatus>('idle');
	hasMore = $state(false);
	/** Set while a request is out, so the shell can show it and not stack them. */
	loading = $state(false);
	/** Ids that arrived live, so a card animates in exactly once. */
	arrived = $state<string[]>([]);

	private cursor: string | null = null;
	private holding = false;
	private stream: StreamLike | null = null;
	/** The mode of the coalesced refetch waiting to run, or `null` if none is. */
	private queued: 'merge' | 'replace' | null = null;
	private inFlight: Promise<void> | null = null;
	/** The mode of a refetch wanted *after* the one in flight. */
	private again: 'merge' | 'replace' | null = null;

	private readonly project: string | null;
	private readonly limit: number;
	private readonly fetcher: Fetcher;
	private readonly open: (url: string) => StreamLike;
	private readonly schedule: (run: () => void) => void;
	private readonly listener = (event: MessageEvent) => this.receive(event);
	private readonly onOpen = () => {
		this.status = 'live';
	};
	private readonly onError = () => {
		// `EventSource` reconnects on its own; this only stops the shell from
		// implying the data is current while it is not.
		if (this.stream) this.status = 'offline';
	};

	constructor(options: TimelineOptions = {}) {
		this.project = options.project ?? null;
		this.limit = options.limit ?? DEFAULT_LIMIT;
		this.fetcher = options.fetch ?? defaultFetch;
		this.open = options.openStream ?? ((url) => new EventSource(url) as StreamLike);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
	}

	/** How many arrivals the pill is offering. */
	get pendingCount(): number {
		return this.pending.length;
	}

	/** Did this card arrive live? Drives the entry animation, nothing else. */
	isNew(id: string): boolean {
		return this.arrived.includes(id);
	}

	/**
	 * Adopt the snapshot the page was server-rendered with.
	 *
	 * Doing this instead of fetching on mount is the difference between a shell
	 * that paints with content and one that paints empty and then fills in.
	 */
	hydrate(snapshot: SnapshotResponse): void {
		this.apply(snapshot, 'replace');
	}

	/**
	 * Connect.
	 *
	 * The cursor goes in the query string because `EventSource` cannot set
	 * headers: the server accepts `last_event_id` there for exactly this case, so
	 * a page that hydrated at seq 41 resumes at 41 rather than replaying the
	 * whole ring buffer or missing what happened while the HTML was in flight.
	 */
	start(): void {
		if (this.stream) return;
		const url = this.seq > 0 ? `/api/stream?last_event_id=${this.seq}` : '/api/stream';
		this.stream = this.open(url);
		this.stream.addEventListener('open', this.onOpen);
		this.stream.addEventListener('error', this.onError);
		for (const type of WATCHED) this.stream.addEventListener(type, this.listener);
		this.status = 'live';

		// Nothing was server-rendered, so there is state to go and get.
		if (this.seq === 0 && this.items.length === 0) this.scheduleRefresh('replace');
	}

	/** Disconnect. Safe to call twice; the shell calls it on unmount. */
	stop(): void {
		if (!this.stream) return;
		for (const type of WATCHED) this.stream.removeEventListener(type, this.listener);
		this.stream.removeEventListener('open', this.onOpen);
		this.stream.removeEventListener('error', this.onError);
		this.stream.close();
		this.stream = null;
		this.status = 'idle';
	}

	/**
	 * Tell the store whether the reader can see the top of the timeline.
	 *
	 * Returning to the top is the same intent as clicking the pill, so it
	 * releases whatever was held.
	 */
	hold(holding: boolean): void {
		this.holding = holding;
		if (!holding) this.flush();
	}

	/** Release the held arrivals into the timeline. What the pill does. */
	flush(): void {
		if (this.pending.length === 0) return;
		const arrivals = this.pending;
		this.pending = [];
		this.insert(arrivals);
	}

	/** One page older, appended. No-op at the end of the timeline. */
	async loadOlder(): Promise<void> {
		if (!this.hasMore || this.cursor === null || this.loading) return;
		const cursor = this.cursor;
		this.loading = true;
		try {
			const snapshot = await this.read(`/api/snapshot/updates?${this.query({ cursor })}`);
			if (!snapshot) return;
			const known = ids(this.items);
			this.items = [...this.items, ...snapshot.updates.items.filter((item) => !known[item.id])];
			this.cursor = snapshot.updates.nextCursor;
			this.hasMore = snapshot.updates.hasMore;
		} finally {
			this.loading = false;
		}
	}

	/** Refetch now. `replace` rebuilds from scratch, which is what `resync` means. */
	async refresh(mode: 'merge' | 'replace' = 'merge'): Promise<void> {
		if (this.inFlight) {
			// Never two requests at once: remember that another is wanted, and
			// upgrade to `replace` if either caller asked for one.
			this.again = mode === 'replace' || this.again === 'replace' ? 'replace' : 'merge';
			return this.inFlight;
		}

		this.inFlight = this.run(mode);
		try {
			await this.inFlight;
		} finally {
			this.inFlight = null;
		}

		const again = this.again;
		this.again = null;
		if (again) await this.refresh(again);
	}

	private async run(mode: 'merge' | 'replace'): Promise<void> {
		this.loading = true;
		try {
			const snapshot = await this.read(`/api/snapshot?${this.query()}`);
			if (snapshot) this.apply(snapshot, mode);
		} finally {
			this.loading = false;
		}
	}

	private async read(url: string): Promise<SnapshotResponse | null> {
		try {
			const response = await this.fetcher(url);
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as SnapshotResponse;
		} catch {
			// A refetch that fails leaves the state it already had, and the stream
			// will provoke another attempt. Losing the data would be worse.
			this.status = 'offline';
			return null;
		}
	}

	/**
	 * The query string for a snapshot request.
	 *
	 * Assembled by hand rather than with `URLSearchParams`, which in a Svelte
	 * module is a reactivity trap (`svelte/prefer-svelte-reactivity`) and would be
	 * a reactive object standing in for three scalars.
	 */
	private query(extra: { cursor?: string } = {}): string {
		const parts = [`limit=${this.limit}`];
		if (this.project) parts.push(`project=${encodeURIComponent(this.project)}`);
		if (extra.cursor) parts.push(`cursor=${encodeURIComponent(extra.cursor)}`);
		return parts.join('&');
	}

	/**
	 * Fold a snapshot into what we hold.
	 *
	 * `merge` reconciles by id, so paging further into the past survives a live
	 * arrival, and an update that changed (pinned, say) is replaced in place.
	 * `replace` throws away the timeline and takes the server's, because that is
	 * the only correct answer to `resync`.
	 */
	private apply(snapshot: SnapshotResponse, mode: 'merge' | 'replace'): void {
		if (snapshot.projects) this.projects = snapshot.projects;
		this.seq = Math.max(this.seq, snapshot.seq);

		if (mode === 'replace') {
			this.items = snapshot.updates.items;
			this.pending = [];
			this.arrived = [];
			this.cursor = snapshot.updates.nextCursor;
			this.hasMore = snapshot.updates.hasMore;
			return;
		}

		const known = ids(this.items);
		const held = ids(this.pending);
		const incoming: Record<string, UpdateView> = Object.create(null) as Record<string, UpdateView>;
		for (const item of snapshot.updates.items) incoming[item.id] = item;

		// One assignment each: a row we already render is replaced by the fetched
		// version (it may have been pinned or edited since), and anything the
		// fetch knows about that we do not is an arrival.
		this.items = this.items.map((item) => incoming[item.id] ?? item);
		this.pending = this.pending.map((item) => incoming[item.id] ?? item);
		const arrivals = snapshot.updates.items.filter((item) => !known[item.id] && !held[item.id]);

		// The first page is also the whole timeline until something is paged in.
		if (this.items.length === 0 && this.pending.length === 0) {
			this.cursor = snapshot.updates.nextCursor;
			this.hasMore = snapshot.updates.hasMore;
		}

		if (arrivals.length === 0) return;
		// Capped: this exists only so a card can animate once, and an unbounded
		// list of every id ever seen would outlive every use of it.
		this.arrived = [...this.arrived, ...arrivals.map((item) => item.id)].slice(-ARRIVED_MEMORY);
		if (this.holding) this.pending = [...arrivals, ...this.pending];
		else this.insert(arrivals);
	}

	/** Put arrivals in newest-first order alongside what is already rendered. */
	private insert(arrivals: UpdateView[]): void {
		const known = ids(arrivals);
		const merged = [...arrivals, ...this.items.filter((item) => !known[item.id])];
		this.items = merged.sort((left, right) => right.seq - left.seq);
	}

	private receive(event: MessageEvent): void {
		this.status = 'live';
		const frame = parse(event.data);
		if (!frame) return;

		// Already accounted for by the snapshot we hold. Replay after a reconnect
		// lands here, which is why it costs nothing.
		if (frame.type !== 'resync' && frame.seq !== undefined && frame.seq <= this.seq) return;

		// One stream carries every project (design §4), so a page showing one
		// project has to drop what is not its business — otherwise every agent in
		// the deployment provokes a refetch of a timeline that cannot change.
		if (this.elsewhere(frame)) {
			this.seq = Math.max(this.seq, frame.seq ?? 0);
			return;
		}

		if (frame.type === 'update.deleted') {
			// The id is the entire payload, so there is nothing to go and read.
			const id = frame.payload?.updateId;
			if (typeof id !== 'string') return;
			this.items = this.items.filter((item) => item.id !== id);
			this.pending = this.pending.filter((item) => item.id !== id);
			this.seq = Math.max(this.seq, frame.seq ?? 0);
			return;
		}

		this.scheduleRefresh(frame.type === 'resync' ? 'replace' : 'merge');
	}

	/**
	 * Is this event about a project this page is not showing?
	 *
	 * Answered from the project list the page already holds, so it costs no
	 * request. An unknown project id is *not* treated as elsewhere: a project
	 * created since this page loaded is exactly the case that must still refetch.
	 */
	private elsewhere(frame: Frame): boolean {
		if (this.project === null) return false;
		const projectId = frame.payload?.projectId;
		if (typeof projectId !== 'string') return false;
		const scope = this.projects.find((candidate) => candidate.slug === this.project);
		return scope !== undefined && scope.id !== projectId;
	}

	/**
	 * One refetch per burst of events, upgraded to `replace` if any event in the
	 * burst asked for one.
	 *
	 * `replace` wins because it is the strictly stronger answer: rebuilding from
	 * the server's state also satisfies every merge that was queued behind it.
	 */
	private scheduleRefresh(mode: 'merge' | 'replace'): void {
		const wanted = mode === 'replace' || this.queued === 'replace' ? 'replace' : 'merge';
		if (this.queued) {
			this.queued = wanted;
			return;
		}

		this.queued = wanted;
		this.schedule(() => {
			const next = this.queued ?? 'merge';
			this.queued = null;
			void this.refresh(next);
		});
	}
}

/**
 * An id set as a plain record.
 *
 * A `Set` here would trip `svelte/prefer-svelte-reactivity`, and a *reactive*
 * set is the wrong tool: this is a throwaway lookup built inside one function,
 * never state anything renders from.
 */
function ids(items: UpdateView[]): Record<string, true> {
	const seen: Record<string, true> = Object.create(null) as Record<string, true>;
	for (const item of items) seen[item.id] = true;
	return seen;
}

type Frame = { type: string; seq?: number; payload?: Record<string, unknown> };

/** A malformed frame is dropped, not thrown: one bad byte must not kill the feed. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}
