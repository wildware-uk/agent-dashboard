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
import type { AckView, MessageView, MessagesSnapshot } from './types';
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
	/**
	 * The owner's own posts, oldest first (migration 014).
	 *
	 * A message anchored to nothing — no update, no task, and not a reply — is
	 * something they wrote straight into the feed, and it renders as a card of
	 * its own rather than inside somebody else's thread.
	 */
	posts?(): MessageView[];
	/** The replies under one post. */
	repliesTo?(messageId: string): MessageView[];
	/**
	 * What agents have said about one message, newest claim last.
	 *
	 * Usually empty, occasionally one, and more than one only when several agents
	 * answered the same thing — which is why it is a list rather than a state.
	 */
	acksFor?(messageId: string): AckView[];
	/** The same, for a task. */
	acksForTask?(taskId: string): AckView[];
	/**
	 * The conversation on a task rather than an update.
	 *
	 * A task is the other thing an agent and its owner talk about, and the panel
	 * that shows tasks reads its threads through the same store the cards use.
	 */
	forTask(taskId: string): MessageView[];
};

/** The events that change a thread. */
const WATCHED = [
	'message.created',
	// An agent saying "seen it" or "done" (migration 013). Watched here rather
	// than in a store of its own because an acknowledgement has no life apart
	// from the message it is on: it arrives in the same read, and a second store
	// would be a second cursor to keep in step for one field.
	'ack.updated',
	'resync'
] as const;

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
	/**
	 * What agents have said about those messages without words (migration 013).
	 *
	 * Held beside the messages rather than on them: an acknowledgement belongs to
	 * an agent, and one message can carry several. Which of them a card shows is
	 * the card's decision.
	 */
	acks = $state<AckView[]>([]);
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
	private again = false;

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

	/** The owner's own feed posts, oldest first (migration 014). */
	posts(): MessageView[] {
		return this.messages.filter(
			(message) =>
				message.updateId === null &&
				message.taskId === null &&
				!message.replyTo &&
				message.author === 'human'
		);
	}

	/** The replies under one post, oldest first. */
	repliesTo(messageId: string): MessageView[] {
		return this.messages.filter((message) => message.replyTo === messageId);
	}

	/** What agents have said about one message (migration 013). */
	acksFor(messageId: string): AckView[] {
		return this.acks.filter((ack) => ack.messageId === messageId);
	}

	/** The same, for a task. */
	acksForTask(taskId: string): AckView[] {
		return this.acks.filter((ack) => ack.taskId === taskId);
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

	/**
	 * Read the queue now. Never two requests at once.
	 *
	 * A caller that arrives while a fetch is in flight must not simply be handed
	 * that promise: the snapshot it is waiting on was built by the server BEFORE
	 * the event that prompted this call, so applying it raises the cursor past an
	 * item that was never delivered. This store has no poller, so nothing would
	 * repair it until some later, unrelated event arrived — a blocked agent
	 * silently absent from the banner, which is the one lie this must never tell.
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
		// Defaulted rather than merged: a document that carried messages and no
		// acknowledgements is saying there are none, and folding the old list in
		// would leave a tick on a message whose acknowledgement has gone.
		this.acks = snapshot.acks ?? [];
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
