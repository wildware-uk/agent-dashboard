/**
 * The pending-request store (design §5, §7).
 *
 * The same contract as the timeline, the rail and the task panel, for the same
 * reasons (`src/http/README.md`): events carry identifiers, so an arrival is a
 * *reason to refetch* rather than a row to render, and a snapshot is stamped
 * with the seq it is good to so replayed frames cost nothing.
 *
 * Two things are specific to this list, and both come from what a request *is* —
 * an agent stopped dead, waiting on a human.
 *
 * **Nothing is dropped, ever.** The feed shows one card per request, and the store keeps
 * every pending request the server sent, in the server's order (oldest first, so
 * the agent that has waited longest is at the front). There is no page size and
 * no per-project filter: a request belongs to the owner rather than to the
 * project they happen to be looking at, and filtering by the current view would
 * hide a blocked agent behind a sidebar click.
 *
 * **It is not filtered by project even though the store is per page.** See
 * above; this is the one live region where narrowing the query would be a bug
 * rather than an optimisation.
 *
 * The optional browser notification (design §7) lives here rather than in the
 * component: it fires off `request.created`, which is a fact about the stream,
 * and the cards would have to reconstruct "this one is new" from a list it
 * refetches wholesale. Permission is never *asked for* — that is the owner's to
 * grant, and a page that prompts on load is a page people close.
 */
import type { RequestView, RequestsSnapshot } from './types';
import type { Fetcher } from './timeline.svelte';
import {
	DirectLink,
	SharedStream,
	sharedStream,
	type OpenStream,
	type StreamMessage,
	type Subscription
} from './stream';

/** The events that change the queue. */
const WATCHED = ['request.created', 'request.answered', 'resync'] as const;

/** How much the store knows about its connection. */
export type RequestsStatus = 'idle' | 'live' | 'offline';

/** What a new request is announced with, when the owner has allowed it. */
export type Notifier = (request: { question: string; kind: string }) => void;

export type RequestsOptions = {
	fetch?: Fetcher;
	/** The tab's one stream (design §4, #19). Defaults to the shared one. */
	stream?: SharedStream;
	/** Test seam: a stream of this store's own, over this opener. */
	openStream?: OpenStream;
	/** Coalescing hook: a burst of events becomes one request. Tests run it by hand. */
	schedule?: (run: () => void) => void;
	/** Optional desktop notification on `request.created`. Defaults to the browser's. */
	notify?: Notifier | null;
};

export class Requests {
	/** Every request waiting on the owner, longest-blocked first. */
	items = $state<RequestView[]>([]);
	/** The newest event seq this state accounts for. */
	seq = $state(0);
	status = $state<RequestsStatus>('idle');
	loading = $state(false);

	private hub: SharedStream | null;
	private held: Subscription | null = null;
	/** Refcounted: the sidebar's copy is mounted twice on a page that has a drawer. */
	private holders = 0;
	private queued = false;
	private inFlight: Promise<void> | null = null;
	private again = false;

	private readonly fetcher: Fetcher;
	private readonly schedule: (run: () => void) => void;
	private readonly notifier: Notifier | null;
	private readonly listener = (event: StreamMessage) => this.receive(event);
	private readonly onOpen = () => {
		this.status = 'live';
	};
	private readonly onError = () => {
		// `EventSource` reconnects by itself; this only stops the cards implying
		// it is current while it is not.
		if (this.held) this.status = 'offline';
	};

	constructor(options: RequestsOptions = {}) {
		this.fetcher = options.fetch ?? ((url) => fetch(url));
		this.hub =
			options.stream ??
			(options.openStream ? new SharedStream(new DirectLink(options.openStream)) : null);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
		this.notifier = options.notify === undefined ? browserNotifier() : options.notify;
	}

	/** How many agents are stopped, for a heading that says so at a glance. */
	get count(): number {
		return this.items.length;
	}

	/** Adopt a snapshot fetched elsewhere. */
	hydrate(snapshot: RequestsSnapshot): void {
		this.apply(snapshot);
	}

	/** Take a hold on the tab's stream and read the queue. Safe to call twice. */
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

	/** Let go of the stream. Only the last holder releases it. */
	stop(): void {
		if (this.holders > 0) this.holders -= 1;
		if (this.holders > 0) return;
		this.queued = false;
		this.held?.close();
		this.held = null;
		this.status = 'idle';
	}

	/**
	 * Read the queue now. Never two requests at once.
	 *
	 * A caller that arrives while a fetch is in flight must not simply be handed
	 * that promise: the snapshot it is waiting on was built by the server BEFORE
	 * the event that prompted this call, so applying it raises the cursor past an
	 * item that was never delivered. This store has no poller, so nothing would
	 * repair it until some later, unrelated event arrived — a blocked agent
	 * silently absent from the feed, which is the one lie this must never tell.
	 * So remember that another read is wanted and run it once the current one
	 * settles (the same shape as `timeline.svelte.ts`).
	 */
	async refresh(): Promise<void> {
		if (this.inFlight) {
			this.again = true;
			return this.inFlight;
		}

		this.inFlight = this.run();
		try {
			await this.inFlight;
		} finally {
			this.inFlight = null;
		}

		if (this.again) {
			this.again = false;
			await this.refresh();
		}
	}

	private async run(): Promise<void> {
		this.loading = true;
		try {
			const snapshot = await this.read();
			if (snapshot) this.apply(snapshot);
		} finally {
			this.loading = false;
		}
	}

	private async read(): Promise<RequestsSnapshot | null> {
		try {
			const response = await this.fetcher('/api/snapshot/requests');
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as RequestsSnapshot;
		} catch {
			// Keep what we hold: an empty banner would read as "nothing is blocked",
			// which is the one lie this component must never tell.
			this.status = 'offline';
			return null;
		}
	}

	private apply(snapshot: RequestsSnapshot): void {
		this.items = snapshot.requests;
		// Adopted, not raised to the greater of the two: the server's stamp says
		// where the stream *is*, and a seq below the one held means the deployment
		// restarted — its bus counts from zero and is never persisted. Keeping the
		// larger figure would make every event the new process publishes look like a
		// replay and drop it, silently, until somebody reloaded the page.
		this.seq = snapshot.seq;
	}

	private receive(event: StreamMessage): void {
		this.status = 'live';
		const frame = parse(event.data);
		if (!frame) return;

		// Already accounted for. Replay after a reconnect lands here, which is why
		// it costs nothing.
		if (frame.type !== 'resync' && frame.seq !== undefined && frame.seq <= this.seq) return;

		if (frame.type === 'request.created') this.announce(frame);
		this.scheduleRefresh();
	}

	/** Tell the owner, if they have allowed it and the tab is not in front of them. */
	private announce(frame: Frame): void {
		if (!this.notifier) return;
		try {
			this.notifier({
				question: 'An agent is waiting on you',
				kind: String((frame.payload as { kind?: string } | undefined)?.kind ?? 'request')
			});
		} catch {
			// A notification is a courtesy. It must never take the banner down with
			// it, and a browser is free to refuse one for reasons of its own.
		}
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

type Frame = { type: string; seq?: number; payload?: unknown };

/** A malformed frame is dropped, not thrown: one bad byte must not kill the queue. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}

/**
 * The browser's own notification, when the owner has already granted it.
 *
 * Deliberately never calls `requestPermission`: the design calls this optional
 * (§7), and a dashboard that throws a permission prompt at first paint is worse
 * than one that never notifies. `default` and `denied` both mean "no", silently.
 */
export function browserNotifier(): Notifier | null {
	if (typeof Notification === 'undefined') return null;

	return ({ question, kind }) => {
		if (Notification.permission !== 'granted') return;
		new Notification('Agent Dashboard', { body: `${question} (${kind})`, tag: 'owner-request' });
	};
}
