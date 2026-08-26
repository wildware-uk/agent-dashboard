/**
 * The message threads on a page (design §4, §7).
 *
 * Same contract as the timeline, the rail and the task list, for the same
 * reasons (`src/http/README.md`):
 *
 * 1. **Events carry identifiers, not data.** `message.created` knows an id, so
 *    an arrival is a *reason to refetch*, never a row to render. Refetching and
 *    replacing wholesale is what makes double delivery, replay and out-of-order
 *    frames harmless — and it is what makes an owner's reply appear in every
 *    open tab, including the one that sent it, with no reload.
 * 2. **A read is stamped with the seq it is good to**, so replayed frames at or
 *    below it are dropped rather than provoking a request storm.
 *
 * One decision worth stating, because the alternative is the obvious one: this
 * reads **every thread on the page in a single request** rather than one per
 * card. A timeline holds fifty cards; fifty requests to discover that
 * forty-eight of them have no replies is not a thread view, it is a stampede.
 * So the store holds the page's messages and hands each card its own by id.
 *
 * It does not filter events by project, unlike the timeline. A scoped request
 * already returns only this project's messages, and messages are rare — one
 * owner types them — so a refetch that returns an identical list costs less than
 * holding a second copy of the project map in here to avoid it.
 *
 * Writes are not here. `actions.ts` posts the reply and the event brings it
 * back, which is the same consistency rule every other control keeps: there is
 * no optimistic insert to reconcile, and no path where the tab that replied
 * disagrees with the tab that watched.
 */
import type { MessageView, MessagesSnapshot } from './types';
import type { Fetcher } from './timeline.svelte';
import {
	DirectLink,
	SharedStream,
	sharedStream,
	type OpenStream,
	type StreamMessage,
	type Subscription
} from './stream';

/**
 * What a card needs from this store: its own thread, and nothing else.
 *
 * A structural type rather than the class, so a component spec can hand a card
 * two messages without constructing a store, a fetch and a stream to do it.
 */
export type ThreadSource = {
	for(updateId: string): MessageView[];
};

/** The events that change a thread. */
const WATCHED = ['message.created', 'resync'] as const;

/** How much the store knows about its connection. */
export type ThreadsStatus = 'idle' | 'live' | 'offline';

export type ThreadsOptions = {
	/** A project slug to scope every request to. Omit for every project. */
	project?: string | null;
	fetch?: Fetcher;
	/** The tab's one stream (design §4). Defaults to the shared one. */
	stream?: SharedStream;
	/** Test seam: a stream of this store's own, over this opener. */
	openStream?: OpenStream;
	/** Coalescing hook: a burst of events becomes one request. Tests run it by hand. */
	schedule?: (run: () => void) => void;
};

export class Threads {
	/** Every message on this page, oldest first, across every thread. */
	messages = $state<MessageView[]>([]);
	/** The newest event seq this state accounts for. */
	seq = $state(0);
	status = $state<ThreadsStatus>('idle');
	loading = $state(false);

	private hub: SharedStream | null;
	private held: Subscription | null = null;
	/** Whether the page is mounted. A queued refetch after `stop` is dropped. */
	private live = false;
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
		// `EventSource` reconnects by itself; this only stops a card implying its
		// thread is current while it is not.
		if (this.held) this.status = 'offline';
	};

	constructor(options: ThreadsOptions = {}) {
		this.project = options.project ?? null;
		this.fetcher = options.fetch ?? ((url) => fetch(url));
		this.hub =
			options.stream ??
			(options.openStream ? new SharedStream(new DirectLink(options.openStream)) : null);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
	}

	/** One card's thread, oldest first. Empty for a card nobody has replied to. */
	for(updateId: string): MessageView[] {
		return this.messages.filter((message) => message.updateId === updateId);
	}

	/** One task's thread, for the panel that renders tasks (design §7). */
	forTask(taskId: string): MessageView[] {
		return this.messages.filter((message) => message.taskId === taskId);
	}

	/** Adopt a snapshot read elsewhere, without asking for another. */
	hydrate(snapshot: MessagesSnapshot): void {
		this.apply(snapshot);
	}

	/** Take a hold on the tab's stream and read the page's threads. */
	start(): void {
		if (this.live) return;
		this.live = true;

		const hub = (this.hub ??= sharedStream());
		this.held = hub.subscribe({
			types: WATCHED,
			listener: this.listener,
			onOpen: this.onOpen,
			onError: this.onError,
			cursor: this.seq
		});
		this.status = hub.connected ? 'live' : 'offline';

		// Nothing was handed over, so there is state to go and get. A hydrated
		// store already holds it, and a refetch on mount would be a request per
		// page load that could only return what it already has.
		if (this.seq === 0 && this.messages.length === 0) this.scheduleRefresh();
		else if (this.held.missed) this.scheduleRefresh();
	}

	/** Let go of the stream. Safe to call twice; the page calls it on unmount. */
	stop(): void {
		this.live = false;
		// A refetch queued a moment ago must not fire after the page has gone.
		this.queued = false;
		// Only this store's hold: the connection outlives it if the timeline is
		// still reading, and is closed by the hub if nothing is.
		this.held?.close();
		this.held = null;
		this.status = 'idle';
	}

	/** Read the threads now. Never two requests at once. */
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
			? '/api/messages'
			: `/api/messages?project=${encodeURIComponent(this.project)}`;
	}

	private async read(url: string): Promise<MessagesSnapshot | null> {
		try {
			const response = await this.fetcher(url);
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as MessagesSnapshot;
		} catch {
			// Keep what we hold: an empty thread would read as "nobody replied",
			// which is a worse lie than a slightly old one.
			this.status = 'offline';
			return null;
		}
	}

	private apply(snapshot: MessagesSnapshot): void {
		this.messages = snapshot.messages;
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

/** A malformed frame is dropped, not thrown: one bad byte must not kill a thread. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}
