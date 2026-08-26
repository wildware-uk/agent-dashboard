/**
 * The live-agents store behind the right rail (design §4, §7).
 *
 * Presence is derived from heartbeats and never stored as a flag, and this store
 * is the browser's half of that rule: it holds the rows the server handed over
 * and answers "who is online" against **its own clock**, ticking once a second.
 * That is what makes an agent drop off screen the moment it has been quiet for
 * {@link PRESENCE_WINDOW_MS} — no event has to arrive, and none does, because
 * crossing that line is nothing happening rather than something happening.
 *
 * The rest is the same contract as the timeline store:
 *
 * - **Events carry identifiers, not data.** An `agent.presence` frame is a
 *   reason to refetch, so double delivery and replay after a reconnect are free.
 * - **A snapshot is stamped with the seq it is good to**, so replayed frames at
 *   or below it are dropped instead of provoking a request storm.
 *
 * The slow poll is not redundant with the stream. A transition publishes an
 * event, but a heartbeat inside the window deliberately publishes nothing, so
 * without a poll the rail would hold a heartbeat timestamp that ages until it
 * looked offline. Polling on the same order as the heartbeat interval keeps the
 * timestamps fresh; the stream is what makes an arrival or a departure show up
 * at once.
 *
 * It does **not** open its own `EventSource` any more. It used to, and one
 * connection per store was not a tidiness problem but an outage: two per tab
 * meant three tabs exhausted Chromium's six-per-origin limit on HTTP/1.1 and
 * the whole origin stopped answering (#19). The rail now takes a hold on the
 * tab's one stream like every other consumer, and lets go of it on unmount.
 */
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
 * One live agent, as `GET /api/snapshot/agents` sends it.
 *
 * `src/web/` may not import `$domain` (design §2), so this is declared here; the
 * endpoint derives its own type from the domain function, so a renamed field
 * changes the JSON and fails the tests that read these names.
 */
export type LiveAgentView = {
	agentId: string;
	name: string;
	/** The most recently beating session: the run the rail describes. */
	sessionId: string;
	startedAt: number;
	lastHeartbeatAt: number;
	/** How many live sessions this agent has, so two runs read as two. */
	sessions: number;
	host: string | null;
	cwd: string | null;
	model: string | null;
};

/** `GET /api/snapshot/agents`. */
export type AgentsSnapshot = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	agents: LiveAgentView[];
};

/**
 * How recently an agent must have beaten to count as online (design §4).
 *
 * The same 90 seconds the server derives presence from. Both sides deriving it
 * from the same constant is the point: the browser is not being told who is
 * online, it is working it out from timestamps, so a stalled stream cannot leave
 * a stale green dot on screen.
 */
export const PRESENCE_WINDOW_MS = 90_000;

/** How often the rail re-reads who is online, to keep heartbeat times fresh. */
const POLL_MS = 20_000;

/** How often the derived clock moves, which is what expires a heartbeat. */
const TICK_MS = 1_000;

/** The events that change who is on the rail. */
const WATCHED = ['agent.presence', 'resync'] as const;

/** How much the store knows about its connection. */
export type PresenceStatus = 'idle' | 'live' | 'offline';

export type PresenceOptions = {
	fetch?: Fetcher;
	/** The tab's one stream (design §4, #19). Defaults to the shared one. */
	stream?: SharedStream;
	/** Test seam: a stream of this store's own, over this opener. */
	openStream?: OpenStream;
	/** Coalescing hook: a burst of events becomes one request. Tests run it by hand. */
	schedule?: (run: () => void) => void;
	/** The clock presence is derived against. Tests drive it. */
	clock?: () => number;
	pollMs?: number;
	tickMs?: number;
};

export class Presence {
	/** Everyone the server said was online, newest heartbeat first. */
	agents = $state<LiveAgentView[]>([]);
	/** The newest event seq this state accounts for. */
	seq = $state(0);
	status = $state<PresenceStatus>('idle');
	loading = $state(false);
	/** The derived clock. Moves on every tick, which is what expires a heartbeat. */
	now = $state(0);
	/**
	 * Agent id to display name, for everyone this store has ever seen online.
	 *
	 * Presence itself is a derivation that expires; a name is not. An agent that
	 * registers a session while the page is open is announced here, which is what
	 * lets its cards stop showing a ULID without a reload — and when it goes quiet
	 * the name stays, because its updates are still in the timeline (#20).
	 */
	names = $state<Record<string, string>>({});

	/** The tab's stream. Resolved on `start`, so a server render never asks for one. */
	private hub: SharedStream | null;
	/** This store's hold on it, or `null` while the rail is not connected. */
	private held: Subscription | null = null;
	/** Whether the rail is mounted. A queued refetch after `stop` is dropped. */
	private live = false;
	private queued = false;
	private inFlight: Promise<void> | null = null;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private poller: ReturnType<typeof setInterval> | undefined;

	private readonly fetcher: Fetcher;
	private readonly schedule: (run: () => void) => void;
	private readonly clock: () => number;
	private readonly pollMs: number;
	private readonly tickMs: number;
	private readonly listener = (event: StreamMessage) => this.receive(event);
	private readonly onOpen = () => {
		this.status = 'live';
	};
	private readonly onError = () => {
		// `EventSource` reconnects by itself; this only stops the rail from
		// implying it is current while it is not.
		if (this.held) this.status = 'offline';
	};

	constructor(options: PresenceOptions = {}) {
		this.fetcher = options.fetch ?? ((url) => fetch(url));
		this.hub =
			options.stream ??
			(options.openStream ? new SharedStream(new DirectLink(options.openStream)) : null);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
		this.clock = options.clock ?? Date.now;
		this.pollMs = options.pollMs ?? POLL_MS;
		this.tickMs = options.tickMs ?? TICK_MS;
		this.now = this.clock();
	}

	/**
	 * Who is online, derived here rather than trusted from the server.
	 *
	 * The server sent agents that were online when it was asked; this drops any
	 * whose heartbeat has since aged out, so the rail is honest between polls and
	 * honest while the stream is down.
	 */
	get online(): LiveAgentView[] {
		const cutoff = this.now - PRESENCE_WINDOW_MS;
		return this.agents.filter((agent) => agent.lastHeartbeatAt >= cutoff);
	}

	/** Adopt a snapshot that was fetched or server-rendered elsewhere. */
	hydrate(snapshot: AgentsSnapshot): void {
		this.apply(snapshot);
	}

	/** Take a hold on the tab's stream, start the clock, and read who is online. */
	start(): void {
		if (this.live) return;
		this.live = true;
		this.now = this.clock();

		const hub = (this.hub ??= sharedStream());
		this.held = hub.subscribe({
			types: WATCHED,
			listener: this.listener,
			onOpen: this.onOpen,
			onError: this.onError,
			cursor: this.seq
		});
		// No stream at all is survivable — the poll below still keeps the rail
		// fresh — so it is said out loud rather than allowed to take the rail down.
		this.status = hub.connected ? 'live' : 'offline';

		this.ticker = setInterval(() => {
			this.now = this.clock();
		}, this.tickMs);
		this.poller = setInterval(() => this.scheduleRefresh(), this.pollMs);

		this.scheduleRefresh();
	}

	/** Let go of the stream and stop the clock. Safe to call twice. */
	stop(): void {
		this.live = false;
		// A refetch queued a moment ago must not fire after the rail has gone: an
		// unmounted store making requests is how a navigation turns into a leak.
		this.queued = false;
		// Only this store's hold. The connection itself outlives the rail if the
		// timeline is still reading it, and is closed by the hub if it is not.
		this.held?.close();
		this.held = null;

		clearInterval(this.ticker);
		clearInterval(this.poller);
		this.ticker = undefined;
		this.poller = undefined;
		this.status = 'idle';
	}

	/** Read who is online now. Never two requests at once. */
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
			const snapshot = await this.read('/api/snapshot/agents');
			if (snapshot) this.apply(snapshot);
		} finally {
			this.loading = false;
		}
	}

	private async read(url: string): Promise<AgentsSnapshot | null> {
		try {
			const response = await this.fetcher(url);
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as AgentsSnapshot;
		} catch {
			// Keep what we hold and let the clock age it out. Dropping the rail
			// because one request failed would be worse than a slightly old rail.
			this.status = 'offline';
			return null;
		}
	}

	private apply(snapshot: AgentsSnapshot): void {
		// Wholesale, not reconciled by id: presence is a derivation, so the answer
		// is the whole answer — anybody missing from it is not online.
		this.agents = snapshot.agents;
		// Names accumulate instead, for the reason on the field itself: going
		// offline is not being renamed.
		this.names = {
			...this.names,
			...Object.fromEntries(snapshot.agents.map((agent) => [agent.agentId, agent.name]))
		};
		this.seq = Math.max(this.seq, snapshot.seq);
		this.now = this.clock();
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

/**
 * How long ago the last heartbeat was, in words.
 *
 * Seconds matter here in a way they do not on a timeline card: the whole
 * question the rail answers is "is this agent still with us", and "48s ago" is
 * the difference between working and about to drop off. Kept coarse past a
 * minute, because by then the answer is simply "yes, recently".
 */
export function heartbeatLabel(lastHeartbeatAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - lastHeartbeatAt) / 1000));
	if (seconds < 5) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	return `${Math.floor(seconds / 60)}m ago`;
}

type Frame = { type: string; seq?: number };

/** A malformed frame is dropped, not thrown: one bad byte must not kill the rail. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}
