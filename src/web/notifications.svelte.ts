/**
 * The notification list behind the bell (migration 021).
 *
 * Same contract as every other live store here (`src/http/README.md`): events
 * carry identifiers, so an arrival is a *reason to refetch* rather than a row to
 * render, and a read is stamped with the seq it is good to so replayed frames
 * cost nothing.
 *
 * What is specific to this one is why it exists at all. A notification used to
 * be a push message and nothing else — asleep phone, refused permission,
 * dropped payload, and the thing that happened left no trace. The owner asked
 * for the list in the app, so the list is the notification and push is one way
 * of delivering it.
 *
 * Marking seen is a write, and it is here rather than in `actions.ts` because
 * the count it changes is this store's own: the server publishes
 * `notifications.seen`, every tab refetches, and a bell cleared on the desk is
 * cleared on the phone.
 */
import type { NotificationView, NotificationsSnapshot } from './types';
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
const WATCHED = ['notification.created', 'notifications.seen', 'resync'] as const;

export type NotificationsStatus = 'idle' | 'live' | 'offline';

/** A write, which the read `Fetcher` deliberately cannot express. */
export type Poster = (url: string, init: RequestInit) => Promise<Response>;

export type NotificationsOptions = {
	fetch?: Fetcher;
	/** Test seam for the one write this store makes. */
	post?: Poster;
	/** The tab's one stream (design §4). Defaults to the shared one. */
	stream?: SharedStream;
	/** Test seam: a stream of this store's own, over this opener. */
	openStream?: OpenStream;
	/** Coalescing hook: a burst of events becomes one request. Tests run it by hand. */
	schedule?: (run: () => void) => void;
};

export class Notifications {
	/** Newest first, as the panel lists them. */
	items = $state<NotificationView[]>([]);
	/** How many the owner has not looked at: the number on the bell. */
	unseen = $state(0);
	seq = $state(0);
	status = $state<NotificationsStatus>('idle');
	loading = $state(false);

	private hub: SharedStream | null;
	private held: Subscription | null = null;
	private holders = 0;
	private queued = false;
	private inFlight: Promise<void> | null = null;
	private again = false;

	private readonly fetcher: Fetcher;
	private readonly poster: Poster;
	private readonly schedule: (run: () => void) => void;
	private readonly listener = (event: StreamMessage) => this.receive(event);
	private readonly onOpen = () => {
		this.status = 'live';
	};
	private readonly onError = () => {
		if (this.held) this.status = 'offline';
	};

	constructor(options: NotificationsOptions = {}) {
		this.fetcher = options.fetch ?? ((url) => fetch(url));
		this.poster = options.post ?? ((url, init) => fetch(url, init));
		this.hub =
			options.stream ??
			(options.openStream ? new SharedStream(new DirectLink(options.openStream)) : null);
		this.schedule = options.schedule ?? ((run) => setTimeout(run, 0));
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

	/** Let go of the stream. Only the last holder releases it. */
	stop(): void {
		if (this.holders > 0) this.holders -= 1;
		if (this.holders > 0) return;
		this.queued = false;
		this.held?.close();
		this.held = null;
		this.status = 'idle';
	}

	/** Read the list now. Never two requests at once (the shape every store here keeps). */
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

	/**
	 * Mark notifications read: the ones named, or everything.
	 *
	 * Nothing is removed here. The server publishes and the refetch brings the
	 * list back as it now is, which is the same consistency rule every other
	 * control keeps — there is no optimistic edit that can disagree with a write
	 * that failed.
	 */
	async markSeen(ids?: readonly string[]): Promise<void> {
		try {
			const response = await this.poster('/api/notifications/seen', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(ids ? { ids } : {})
			});
			if (!response.ok) return;
			await this.refresh();
		} catch {
			// The bell stays lit. A count that cleared on a failed write would tell
			// the owner they had read something they had not.
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

	private async read(): Promise<NotificationsSnapshot | null> {
		try {
			const response = await this.fetcher('/api/notifications');
			if (!response.ok) {
				this.status = 'offline';
				return null;
			}
			return (await response.json()) as NotificationsSnapshot;
		} catch {
			this.status = 'offline';
			return null;
		}
	}

	private apply(snapshot: NotificationsSnapshot): void {
		this.items = snapshot.notifications;
		this.unseen = snapshot.unseen;
		// Adopted rather than raised: a seq below the one held means the deployment
		// restarted and its bus counts from zero again.
		this.seq = snapshot.seq;
	}

	private receive(event: StreamMessage): void {
		this.status = 'live';
		const frame = parse(event.data);
		if (!frame) return;

		if (frame.type !== 'resync' && frame.seq !== undefined && frame.seq <= this.seq) return;
		this.scheduleRefresh();
	}

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

/** A malformed frame is dropped, not thrown: one bad byte must not kill the bell. */
function parse(data: unknown): Frame | null {
	if (typeof data !== 'string') return null;
	try {
		const value = JSON.parse(data) as Frame;
		return typeof value?.type === 'string' ? value : null;
	} catch {
		return null;
	}
}
