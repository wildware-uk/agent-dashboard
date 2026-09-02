/**
 * The browser's connection to `GET /api/stream` (design §4).
 *
 * Every live region of the dashboard reads the same event stream, and until
 * this module existed each of them opened its own: the timeline store one, the
 * presence store another. That is not a tidiness problem, it is an outage.
 * Chromium allows **six sockets per origin on HTTP/1.1**, an SSE connection
 * holds one for as long as the page is open, and nothing else can jump the
 * queue — so at the limit a snapshot fetch and even a navigation simply never
 * resolve. Two connections per tab meant three tabs killed the origin (#19),
 * which reads as "the dashboard is broken" rather than "too many tabs". HTTP/2
 * hides it; the README quickstart is plain HTTP on localhost, which does not.
 *
 * So there are two layers here, and they answer two different arithmetics.
 *
 * **{@link SharedStream} — one connection per tab.** A ref-counted hub. Every
 * consumer subscribes with the event types it cares about, gets frames for
 * those and nothing else, and hands back an unsubscribe. The first subscriber
 * opens the connection and the last one to leave closes it, so a consumer that
 * unmounts cannot take the stream out from under the ones still on the page,
 * and cannot leave a listener behind either.
 *
 * **{@link LeaderLink} — one connection per browser.** Six tabs holding one
 * socket each is still exactly the limit, so per-tab sharing alone leaves a
 * self-hoster with six tabs open in the same hang. The Web Locks API elects a
 * single leader across every tab of the origin; the leader is the only tab that
 * opens an `EventSource`, and it rebroadcasts each frame on a
 * `BroadcastChannel` that every other tab is listening to. Twenty tabs then
 * cost one socket. The lock is released by the browser when the leading tab
 * closes or crashes, so a queued follower is granted it and takes over with no
 * protocol of our own; the ping and the steal below cover the one case the lock
 * cannot see, which is a leader that is still alive but frozen.
 *
 * Neither layer changes the contract the stores are written against
 * (`src/http/README.md`):
 *
 * - **`Last-Event-ID` resume** — the cursor is the newest seq the tab has seen,
 *   raised by each consumer's hydrated seq, and it goes in the query string
 *   because `EventSource` cannot set headers. A reconnect the browser performs
 *   by itself carries the header; one *we* perform carries the query.
 * - **`resync`** — an ordinary event type here, forwarded like any other, so the
 *   refetch path in each store is untouched.
 * - **Filtering** — per consumer, by event type, so a store still never sees a
 *   frame it has no answer for.
 */

/** The slice of `EventSource` this module uses. Injected, so tests need no server. */
export type StreamLike = {
	addEventListener(type: string, listener: (event: MessageEvent) => void): void;
	removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
	close(): void;
};

/** How a connection is opened. The browser's own `EventSource` satisfies it. */
export type OpenStream = (url: string) => StreamLike;

/**
 * Every event type the transport carries (design §4).
 *
 * The whole list, not the subset today's stores watch, because the leading tab
 * subscribes on behalf of tabs it cannot see: a frame it did not register for
 * is a frame no follower can ever receive. Consumers still filter, so a store
 * gains nothing it did not ask for.
 */
export const EVENT_TYPES = [
	'project.created',
	'project.updated',
	'update.created',
	'update.updated',
	'update.deleted',
	'media.ready',
	'task.created',
	'task.updated',
	'message.created',
	// An agent saying "on it" or "done" without words (migration 013).
	'ack.updated',
	'request.created',
	'request.answered',
	'agent.presence',
	// The owner renamed an agent: every card it posted is relabelled.
	'agent.renamed',
	'resync'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * What a consumer is handed.
 *
 * The shape of a `MessageEvent` a store actually reads, rather than the event
 * itself: a frame that reached this tab over a `BroadcastChannel` was never a
 * DOM event, and pretending otherwise would be a cast rather than a type.
 */
export type StreamMessage = { type: string; data: string; lastEventId: string };

/** One frame as a link hands it up: the event name, its body, and its seq. */
export type StreamFrame = { type: string; data: string; seq: number };

/** What a link tells the hub. */
export type LinkHandlers = {
	frame(frame: StreamFrame): void;
	opened(): void;
	failed(): void;
};

/**
 * How a tab gets its frames.
 *
 * Two implementations: {@link DirectLink} opens a connection, {@link LeaderLink}
 * arranges for exactly one tab to. `cursor` is read at connect time rather than
 * passed once, because a link may connect long after it was started — which is
 * precisely what a follower promoted to leader does.
 */
export type Link = {
	start(handlers: LinkHandlers, cursor: () => number): void;
	stop(): void;
	readonly connected: boolean;
};

/** One consumer's registration. */
export type StreamConsumer = {
	/** The event types this consumer wants. Everything else is not its business. */
	types: readonly string[];
	listener: (event: StreamMessage) => void;
	onOpen?: () => void;
	onError?: () => void;
	/** The newest seq this consumer already accounts for, so the resume is honest. */
	cursor?: number;
};

/** A consumer's hold on the stream. */
export type Subscription = {
	/**
	 * Did this consumer join a connection that was already ahead of it?
	 *
	 * True means frames arrived before it subscribed, so the state it hydrated
	 * with may be stale and it should refetch. False means it either opened the
	 * connection or was already up to date.
	 */
	readonly missed: boolean;
	/** Release the hold. Idempotent: calling it twice releases one consumer. */
	close(): void;
};

const STREAM_PATH = '/api/stream';

/**
 * The lock and the channel are named after the endpoint they arbitrate.
 *
 * Exported because they are the contract *between tabs* rather than an
 * implementation detail of one: `stream.e2e.ts` listens on the channel to prove
 * that a frame the leading tab received reached the others.
 */
export const CHANNEL_NAME = 'agent-dashboard:stream';
export const LOCK_NAME = 'agent-dashboard:stream-leader';

/** How often the leading tab says it is still there. */
const PING_MS = 5_000;

/** How long a follower waits in silence before taking the lock by force. */
const TAKEOVER_MS = 20_000;

function defaultOpen(url: string): StreamLike {
	return new EventSource(url) as StreamLike;
}

/**
 * The seq a frame belongs to.
 *
 * `id:` is what a reconnect resumes from, so it is read first; the body's own
 * `seq` is the fallback, and a frame carrying neither leaves the cursor where it
 * was rather than resuming from zero and replaying the whole ring buffer.
 */
function seqOf(event: MessageEvent): number {
	const id = Number(event.lastEventId);
	if (Number.isFinite(id) && id > 0) return id;
	try {
		const body = JSON.parse(String(event.data)) as { seq?: unknown };
		return typeof body?.seq === 'number' ? body.seq : 0;
	} catch {
		return 0;
	}
}

/** This tab's own connection to the endpoint. */
export class DirectLink implements Link {
	private source: StreamLike | null = null;
	private handlers: LinkHandlers | null = null;
	private readonly attached = new Map<string, (event: MessageEvent) => void>();
	private readonly onOpen = () => this.handlers?.opened();
	private readonly onError = () => this.handlers?.failed();

	constructor(
		private readonly openStream: OpenStream = defaultOpen,
		private readonly path: string = STREAM_PATH
	) {}

	get connected(): boolean {
		return this.source !== null;
	}

	start(handlers: LinkHandlers, cursor: () => number): void {
		if (this.source) return;
		this.handlers = handlers;
		const at = cursor();
		const url = at > 0 ? `${this.path}?last_event_id=${at}` : this.path;

		try {
			this.source = this.openStream(url);
		} catch {
			// A browser with no `EventSource` at all is survivable — the stores poll
			// and refetch — so it must not take the page down with it.
			this.source = null;
			handlers.failed();
			return;
		}

		this.source.addEventListener('open', this.onOpen);
		this.source.addEventListener('error', this.onError);
		// One listener per type, closed over the type: `EventSource` names the event
		// on the wire, and reading it back off the parsed body would make a frame
		// whose `data` failed to parse undeliverable.
		for (const type of EVENT_TYPES) {
			const listener = (event: MessageEvent) => {
				this.handlers?.frame({ type, data: String(event.data), seq: seqOf(event) });
			};
			this.attached.set(type, listener);
			this.source.addEventListener(type, listener);
		}
	}

	stop(): void {
		const source = this.source;
		this.source = null;
		this.handlers = null;
		if (!source) return;
		for (const [type, listener] of this.attached) source.removeEventListener(type, listener);
		this.attached.clear();
		source.removeEventListener('open', this.onOpen);
		source.removeEventListener('error', this.onError);
		source.close();
	}
}

/**
 * The tab's one stream, shared by every consumer.
 *
 * Ref-counted rather than reference-free: the shell, the rail and whatever #14
 * and #15 add all come and go independently, and the connection has to outlive
 * any one of them while outliving none of them.
 */
export class SharedStream {
	private readonly consumers = new Set<StreamConsumer>();
	private cursor = 0;

	private readonly handlers: LinkHandlers = {
		frame: (frame) => {
			// `resync` is the server stating where the stream actually is, so its seq
			// is adopted rather than raised to the greater of the two. Every other
			// frame only ever moves forward within one server lifetime.
			//
			// The case this exists for is a restart. The bus counts from zero in the
			// server's memory and is never persisted, so a redeployed process issues
			// 1, 2, 3 again — and a cursor still holding a figure from the previous
			// process would resume from a seq that server has not reached, be told
			// `resync`, and then keep asking for the same impossible cursor on every
			// reconnect afterwards.
			this.cursor = frame.type === 'resync' ? frame.seq : Math.max(this.cursor, frame.seq);
			const message: StreamMessage = {
				type: frame.type,
				data: frame.data,
				lastEventId: String(frame.seq)
			};
			// Over a copy: a consumer is allowed to unsubscribe from inside its own
			// listener, and a store that resyncs by remounting does exactly that.
			for (const consumer of [...this.consumers]) {
				if (consumer.types.includes(frame.type)) consumer.listener(message);
			}
		},
		opened: () => {
			for (const consumer of [...this.consumers]) consumer.onOpen?.();
		},
		failed: () => {
			for (const consumer of [...this.consumers]) consumer.onError?.();
		}
	};

	constructor(private readonly link: Link = new DirectLink()) {}

	/** The newest seq this tab has seen. What a reconnect resumes from. */
	get seq(): number {
		return this.cursor;
	}

	/** How many consumers are holding the stream open. */
	get subscribers(): number {
		return this.consumers.size;
	}

	/** Is there a connection behind this, as far as the link can tell? */
	get connected(): boolean {
		return this.link.connected;
	}

	/**
	 * Bring a tab that may have been asleep back into line (design §4).
	 *
	 * The case this exists for is the one nothing else can see. A backgrounded
	 * tab — a phone with the dashboard on its home screen, a laptop lid closed
	 * for an hour — can have its connection dropped by the OS, the network or an
	 * intermediary without the page ever being run to hear about it. `EventSource`
	 * reconnects by itself when it *notices*, and a frozen page notices nothing:
	 * it wakes up believing it is connected, and stays silent until somebody
	 * reloads. Which is exactly what "sometimes I have to refresh" is.
	 *
	 * Two halves, and both are needed. **`resync` repairs the data**: every store
	 * refetches its snapshot, so whatever arrived while this tab was not listening
	 * is on screen even if the socket was fine. **The reconnect repairs the
	 * future**: a socket that died quietly is replaced, resuming from this tab's
	 * cursor, so the next event actually lands. A resync without the reconnect
	 * leaves a tab correct once and deaf afterwards.
	 *
	 * Doing nothing when nobody is subscribed is deliberate: there is no
	 * connection to repair and no store to tell.
	 */
	revive(options: { reconnect?: boolean } = {}): void {
		if (this.consumers.size === 0) return;

		if (options.reconnect) {
			this.link.stop();
			this.link.start(this.handlers, () => this.cursor);
		}

		// The same frame the server sends when a cursor is too old for the replay
		// buffer, so the refetch path in every store is the one already written and
		// already tested (`src/http/README.md`).
		const message: StreamMessage = {
			type: 'resync',
			data: '{}',
			lastEventId: String(this.cursor)
		};
		for (const consumer of [...this.consumers]) {
			if (consumer.types.includes('resync')) consumer.listener(message);
		}
	}

	/**
	 * Take a hold on the stream.
	 *
	 * The first hold connects, resuming from the newest cursor any consumer has
	 * offered — which is what makes a page that was server-rendered at seq 41
	 * resume at 41 rather than replaying the ring buffer from the beginning.
	 */
	subscribe(consumer: StreamConsumer): Subscription {
		const offered = consumer.cursor ?? 0;
		// Asked before the cursor is raised: a consumer joining a stream that is
		// already past it has a gap to close, and one that opened the stream has
		// nothing to close.
		const missed = this.consumers.size > 0 && this.cursor > offered;
		this.cursor = Math.max(this.cursor, offered);
		this.consumers.add(consumer);
		if (this.consumers.size === 1) this.link.start(this.handlers, () => this.cursor);

		let held = true;
		return {
			missed,
			close: () => {
				if (!held) return;
				held = false;
				this.consumers.delete(consumer);
				if (this.consumers.size === 0) this.link.stop();
			}
		};
	}
}

/** The `navigator.locks` surface this module uses. */
export type LockManagerLike = {
	request(
		name: string,
		options: { signal?: AbortSignal; steal?: boolean },
		callback: () => Promise<void>
	): Promise<unknown>;
};

/** The `BroadcastChannel` surface this module uses. */
export type ChannelLike = {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	close(): void;
};

/** What the leading tab says on the channel. */
type Broadcast =
	{ kind: 'frame'; frame: StreamFrame } | { kind: 'open' } | { kind: 'error' } | { kind: 'alive' };

export type LeaderOptions = {
	locks: LockManagerLike;
	channel: () => ChannelLike;
	/** The link the elected tab uses. Built lazily: a follower never opens one. */
	connect: () => Link;
	name?: string;
	pingMs?: number;
	takeoverMs?: number;
};

/**
 * One connection per browser rather than per tab.
 *
 * The lock is the election: `navigator.locks.request` grants it to one tab and
 * queues the rest, and the browser releases it when the holder's tab goes away
 * — including when it crashes, which is the part no protocol written in a page
 * can do for itself. The queued follower is then granted the lock and opens its
 * own connection, resuming from the seq it had already been told about.
 *
 * The ping and the takeover cover the case the lock cannot: a leader that is
 * still holding it but has stopped running, which is what a frozen background
 * tab is. Followers hear "alive" while it is healthy and steal the lock after
 * {@link TAKEOVER_MS} of silence. A steal is safe to race: the browser leaves
 * exactly one holder, and the tab that lost sees its own request reject and
 * closes the connection it was holding.
 */
export class LeaderLink implements Link {
	private handlers: LinkHandlers | null = null;
	private cursor: () => number = () => 0;
	private channel: ChannelLike | null = null;
	private link: Link | null = null;
	private abort: AbortController | null = null;
	/** Set while this tab holds the lock; calling it hands the lock back. */
	private release: (() => void) | null = null;
	private pinger: ReturnType<typeof setInterval> | undefined;
	private takeover: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	/** Set when the election itself is unusable and this tab connected anyway. */
	private soloed = false;
	/** A follower's view of the leader's connection. */
	private heard = true;

	private readonly name: string;
	private readonly pingMs: number;
	private readonly takeoverMs: number;

	private readonly onMessage = (event: { data: unknown }) => this.receive(event.data as Broadcast);

	constructor(private readonly options: LeaderOptions) {
		this.name = options.name ?? LOCK_NAME;
		this.pingMs = options.pingMs ?? PING_MS;
		this.takeoverMs = options.takeoverMs ?? TAKEOVER_MS;
	}

	/** Whether this tab is the one holding the connection. */
	get leading(): boolean {
		return this.release !== null || this.soloed;
	}

	get connected(): boolean {
		return this.link ? this.link.connected : this.heard;
	}

	start(handlers: LinkHandlers, cursor: () => number): void {
		if (this.running) return;
		this.running = true;
		this.handlers = handlers;
		this.cursor = cursor;
		this.heard = true;
		this.channel = this.options.channel();
		this.channel.addEventListener('message', this.onMessage);
		this.watch();
		this.elect();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		clearInterval(this.pinger);
		clearTimeout(this.takeover);
		this.pinger = undefined;
		this.takeover = undefined;
		this.demote();
		// Releasing the lock is what promotes a tab that is still open, so it has
		// to happen before the channel goes: a follower granted the lock a moment
		// later must find somebody listening.
		this.release?.();
		this.release = null;
		this.abort?.abort();
		this.abort = null;
		this.channel?.removeEventListener('message', this.onMessage);
		this.channel?.close();
		this.channel = null;
		this.handlers = null;
	}

	/** Ask for the lock. Granted now if it is free, queued behind the leader if not. */
	private elect(steal = false): void {
		// `steal` and `signal` cannot be combined, and a steal is not a request
		// that waits, so there is nothing to abort.
		this.abort = steal ? null : new AbortController();
		const options = steal ? { steal: true } : { signal: this.abort!.signal };

		let requested: Promise<unknown>;
		try {
			requested = this.options.locks.request(this.name, options, () => {
				if (!this.running) return Promise.resolve();
				// Held until this promise settles, which is what makes the callback
				// the whole of this tab's leadership.
				return new Promise<void>((resolve) => {
					this.release = resolve;
					this.lead();
				});
			});
		} catch {
			// The election is not available to this tab at all. One connection of
			// its own is a worse outcome than sharing and a much better one than a
			// page that never hears anything again.
			this.soloed = true;
			this.lead();
			return;
		}

		requested.catch(() => {
			// Aborted on `stop`, or stolen by a tab that thought this one had gone
			// quiet. Either way this tab is not the leader any more: it lets the
			// connection go and joins the queue behind whoever has it now, so a
			// tab that was demoted is still the one that takes over when *that*
			// tab closes.
			//
			// Deliberately without arming the takeover clock. The clock is armed
			// again by the first thing the new leader says, and a tab that has
			// just lost the lock re-arming it blind is how two tabs end up
			// stealing it from each other forever.
			//
			// Only a tab that *had* the lock asks for it again. A request that
			// failed without ever holding it failed for a reason asking again
			// would not change, and an election that rejects on sight would
			// otherwise spin this tab forever.
			const lost = this.release !== null;
			this.release = null;
			this.demote();
			if (this.running && lost) this.elect();
		});
	}

	/** Open the connection, and start saying so. */
	private lead(): void {
		clearTimeout(this.takeover);
		this.takeover = undefined;
		this.link = this.options.connect();
		this.link.start(
			{
				frame: (frame) => {
					this.handlers?.frame(frame);
					this.say({ kind: 'frame', frame });
				},
				opened: () => {
					this.handlers?.opened();
					this.say({ kind: 'open' });
				},
				failed: () => {
					this.handlers?.failed();
					this.say({ kind: 'error' });
				}
			},
			this.cursor
		);
		this.say({ kind: 'alive' });
		this.pinger = setInterval(() => this.say({ kind: 'alive' }), this.pingMs);
	}

	/** Stop being the tab with the connection. */
	private demote(): void {
		clearInterval(this.pinger);
		this.pinger = undefined;
		this.soloed = false;
		this.link?.stop();
		this.link = null;
	}

	/** Start the clock on a silent leader. */
	private watch(): void {
		if (!this.running || this.leading) return;
		clearTimeout(this.takeover);
		this.takeover = setTimeout(() => {
			if (!this.running || this.leading) return;
			this.elect(true);
		}, this.takeoverMs);
	}

	private say(message: Broadcast): void {
		this.channel?.postMessage(message);
	}

	/**
	 * A message from the leading tab.
	 *
	 * Anything at all is proof of life, so the takeover clock is restarted on
	 * every message rather than only on a ping.
	 */
	private receive(message: Broadcast): void {
		if (!this.running || this.leading) return;
		this.watch();
		if (message.kind === 'frame') {
			this.heard = true;
			this.handlers?.frame(message.frame);
			return;
		}
		if (message.kind === 'open') {
			this.heard = true;
			this.handlers?.opened();
			return;
		}
		if (message.kind === 'error') {
			this.heard = false;
			this.handlers?.failed();
		}
	}
}

/** The two platform apis the election needs, or nothing where they are missing. */
export type Platform = {
	locks?: LockManagerLike;
	channel?: (name: string) => ChannelLike;
};

/** What this environment actually offers. */
function platform(): Platform {
	const locks =
		typeof navigator === 'undefined' ? undefined : (navigator.locks as LockManagerLike | undefined);
	const channel =
		typeof BroadcastChannel === 'function'
			? (name: string) => new BroadcastChannel(name) as ChannelLike
			: undefined;
	return { locks, channel };
}

/**
 * The link this browser can actually use.
 *
 * Web Locks needs a secure context — which `localhost` is, so the README
 * quickstart gets the shared connection — and `BroadcastChannel` needs a browser
 * at all. Where either is missing the tab simply keeps its own connection, which
 * is one per tab rather than one per store: still the fix for #19's reproduction,
 * just without the headroom above six tabs.
 */
export function browserLink(openStream?: OpenStream, env: Platform = platform()): Link {
	const connect = () => new DirectLink(openStream);
	const { locks, channel } = env;
	if (!locks || !channel) return connect();
	return new LeaderLink({ locks, channel: () => channel(CHANNEL_NAME), connect });
}

/**
 * How long a tab must have been hidden before waking it warrants a new socket.
 *
 * A glance at another window and back is not a connection problem, and tearing
 * the stream down for one would churn the leader election every time the owner
 * alt-tabs. Half a minute is past the point where a phone has had time to
 * suspend the page.
 */
export const STALE_HIDDEN_MS = 30_000;

/**
 * Repair the stream when this tab comes back to life.
 *
 * Registered once, on the hub, for as long as the page exists — deliberately not
 * per store, because the thing being recovered is the connection they share.
 *
 * `online` always reconnects: the browser is telling us the previous socket
 * cannot have survived. `visibilitychange` reconnects only after a long hide,
 * for the reason {@link STALE_HIDDEN_MS} gives, but resyncs either way — a tab
 * that was hidden for ten seconds may still have missed something, and one
 * snapshot refetch is cheap next to a dashboard quietly showing yesterday.
 */
function reviveOnWake(hub: SharedStream): void {
	if (typeof document === 'undefined' || typeof window === 'undefined') return;

	let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			hiddenAt = Date.now();
			return;
		}

		const asleep = hiddenAt === null ? 0 : Date.now() - hiddenAt;
		hiddenAt = null;
		hub.revive({ reconnect: asleep >= STALE_HIDDEN_MS || !hub.connected });
	});

	window.addEventListener('online', () => hub.revive({ reconnect: true }));

	// A page restored from the back-forward cache was never torn down and never
	// re-run: its `EventSource` is whatever the browser left of it, which on iOS
	// is usually nothing. `persisted` is the browser saying exactly that, so this
	// one always takes a fresh socket.
	window.addEventListener('pageshow', (event) => {
		if ((event as PageTransitionEvent).persisted) hub.revive({ reconnect: true });
	});
}

let shared: SharedStream | null = null;

/**
 * This tab's stream. Everything live on the page reads it.
 *
 * Built on first use rather than at module scope, because this module is
 * imported during the server render and a hub created there would be one object
 * shared by every request that never connects to anything.
 */
export function sharedStream(): SharedStream {
	if (shared) return shared;
	shared = new SharedStream(browserLink());
	reviveOnWake(shared);
	return shared;
}
