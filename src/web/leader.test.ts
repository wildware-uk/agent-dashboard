import { describe, expect, it, vi } from 'vitest';
import {
	DirectLink,
	LeaderLink,
	SharedStream,
	browserLink,
	type ChannelLike,
	type LockManagerLike,
	type StreamMessage
} from './stream';
import { FakeStream } from './testing';

/**
 * One connection per *browser*, not per tab.
 *
 * Six tabs holding one socket each is still exactly Chromium's limit of six per
 * origin on HTTP/1.1, so per-tab sharing alone leaves a self-hoster with six
 * tabs open in the same hang (#19). These tests drive several "tabs" against one
 * lock manager and one channel, which is what the browser gives every tab of an
 * origin, and assert that only one of them ever opens anything.
 */

/** `navigator.locks`, in as much as this module uses: exclusive, queued, stealable. */
class FakeLocks implements LockManagerLike {
	private holder: { revoke(): void } | null = null;
	private readonly waiting: { grant(): void; abort(): void }[] = [];

	request(
		name: string,
		options: { signal?: AbortSignal; steal?: boolean },
		callback: () => Promise<void>
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const hold = () => {
				let done = false;
				const finish = (pump: boolean) => {
					if (done) return;
					done = true;
					this.holder = null;
					if (pump) this.pump();
				};
				this.holder = {
					// A stolen lock does not go back to the queue: it goes to the thief.
					revoke: () => {
						finish(false);
						reject(new Error('AbortError'));
					}
				};
				callback().then(
					() => {
						finish(true);
						resolve(undefined);
					},
					(cause: unknown) => {
						finish(true);
						reject(cause);
					}
				);
			};

			if (options.steal === true) {
				this.holder?.revoke();
				hold();
				return;
			}

			const entry = { grant: hold, abort: () => reject(new Error('AbortError')) };
			options.signal?.addEventListener('abort', () => {
				const at = this.waiting.indexOf(entry);
				if (at < 0) return;
				this.waiting.splice(at, 1);
				entry.abort();
			});
			this.waiting.push(entry);
			this.pump();
		});
	}

	/** Granting is asynchronous in the real API, so it is asynchronous here. */
	private pump(): void {
		void Promise.resolve().then(() => {
			if (this.holder || this.waiting.length === 0) return;
			this.waiting.shift()!.grant();
		});
	}
}

/** `BroadcastChannel`: every other channel on the bus hears it, the sender does not. */
class FakeBus {
	readonly channels = new Set<FakeChannel>();

	open(): FakeChannel {
		const channel = new FakeChannel(this);
		this.channels.add(channel);
		return channel;
	}

	send(from: FakeChannel, message: unknown): void {
		// A channel that has left the bus neither hears nor is heard, which is what
		// makes it a stand-in for a tab that has stopped running.
		if (!this.channels.has(from)) return;
		for (const channel of [...this.channels]) if (channel !== from) channel.deliver(message);
	}
}

class FakeChannel implements ChannelLike {
	private readonly listeners = new Set<(event: { data: unknown }) => void>();

	constructor(private readonly bus: FakeBus) {}

	postMessage(message: unknown): void {
		this.bus.send(this, message);
	}

	addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
		this.listeners.add(listener);
	}

	removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
		this.listeners.delete(listener);
	}

	close(): void {
		this.listeners.clear();
		this.bus.channels.delete(this);
	}

	deliver(message: unknown): void {
		for (const listener of [...this.listeners]) listener({ data: message });
	}
}

/** Everything one browser shares between its tabs. */
function browser(options: { pingMs?: number; takeoverMs?: number } = {}) {
	const locks = new FakeLocks();
	const bus = new FakeBus();
	const opened: string[] = [];
	const streams: FakeStream[] = [];

	/** One tab: its own hub, its own link, the browser's lock and channel. */
	function tab(cursor = 0) {
		let channel: FakeChannel | null = null;
		const link = new LeaderLink({
			locks,
			channel: () => (channel = bus.open()),
			connect: () =>
				new DirectLink((url) => {
					const stream = new FakeStream();
					stream.url = url;
					opened.push(url);
					streams.push(stream);
					return stream;
				}),
			pingMs: options.pingMs ?? 5,
			takeoverMs: options.takeoverMs ?? 60_000
		});
		const stream = new SharedStream(link);
		const seen: StreamMessage[] = [];
		let errors = 0;
		const held = stream.subscribe({
			types: ['update.created', 'agent.presence', 'resync'],
			listener: (event) => void seen.push(event),
			onError: () => void (errors += 1),
			cursor
		});
		return {
			link,
			stream,
			seen,
			held,
			get errors() {
				return errors;
			},
			/**
			 * What a frozen background tab is: still holding the lock, still holding
			 * the socket, no longer running any of this.
			 */
			freeze() {
				if (channel) bus.channels.delete(channel);
			}
		};
	}

	return { locks, bus, opened, streams, tab };
}

/** Let the lock manager grant what it has queued. */
async function settle(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) await Promise.resolve();
}

describe('electing one tab to hold the connection', () => {
	it('opens a single connection however many tabs are open', async () => {
		const browsing = browser();
		const tabs = [browsing.tab(), browsing.tab(), browsing.tab(), browsing.tab(), browsing.tab()];

		await settle();

		expect(browsing.opened).toEqual(['/api/stream']);
		expect(tabs.filter((one) => one.link.leading)).toHaveLength(1);
	});

	it('hands a frame the leading tab received to every other tab', async () => {
		const browsing = browser();
		const first = browsing.tab();
		const second = browsing.tab();
		const third = browsing.tab();
		await settle();

		browsing.streams[0].emit('update.created', { seq: 12, payload: { updateId: 'u1' } });

		for (const one of [first, second, third]) {
			expect(one.seen.map((event) => event.type)).toEqual(['update.created']);
			expect(JSON.parse(one.seen[0].data)).toMatchObject({ payload: { updateId: 'u1' } });
		}
	});

	it('tells every tab when the connection drops', async () => {
		const browsing = browser();
		const leader = browsing.tab();
		const follower = browsing.tab();
		await settle();

		browsing.streams[0].fire('error');

		expect([leader.errors, follower.errors]).toEqual([1, 1]);
		expect(follower.stream.connected).toBe(false);
	});
});

describe('when the leading tab goes away', () => {
	it('promotes a tab that is still open, resuming from what it was told', async () => {
		const browsing = browser();
		const leader = browsing.tab();
		const follower = browsing.tab();
		await settle();
		browsing.streams[0].emit('update.created', { seq: 12 });

		// The owner closes the leading tab.
		leader.held.close();
		await settle();

		expect(follower.link.leading).toBe(true);
		expect(browsing.opened).toEqual(['/api/stream', '/api/stream?last_event_id=12']);
		expect(browsing.streams[0].closed).toBe(true);
	});

	it('keeps serving the tabs that remain', async () => {
		const browsing = browser();
		const leader = browsing.tab();
		const first = browsing.tab();
		const second = browsing.tab();
		await settle();

		leader.held.close();
		await settle();
		browsing.streams[1].emit('agent.presence', { seq: 20 });

		expect(first.seen.map((event) => event.type)).toEqual(['agent.presence']);
		expect(second.seen.map((event) => event.type)).toEqual(['agent.presence']);
	});
});

describe('when the leading tab stops running but keeps the lock', () => {
	it('is taken over by a tab that has heard nothing for too long', async () => {
		// The one case the lock cannot see: the tab is still there, so the browser
		// has nothing to release, but it has stopped running.
		const browsing = browser({ pingMs: 2, takeoverMs: 25 });
		const leader = browsing.tab();
		const follower = browsing.tab();
		await settle();
		expect(leader.link.leading).toBe(true);

		leader.freeze();

		await vi.waitFor(
			() => {
				expect(follower.link.leading).toBe(true);
			},
			{ timeout: 2000 }
		);
		// Exactly one connection again: the tab that lost the lock let go of its own.
		expect(browsing.opened).toHaveLength(2);
		expect(browsing.streams[0].closed).toBe(true);
		expect(leader.link.leading).toBe(false);
	});

	it('settles on one leader rather than stealing back and forth', async () => {
		const browsing = browser({ pingMs: 2, takeoverMs: 25 });
		const leader = browsing.tab();
		const follower = browsing.tab();
		await settle();
		leader.freeze();
		await vi.waitFor(
			() => {
				expect(follower.link.leading).toBe(true);
			},
			{ timeout: 2000 }
		);

		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(browsing.opened).toHaveLength(2);
		expect(follower.link.leading).toBe(true);
	});

	it('leaves a healthy leader alone', async () => {
		const browsing = browser({ pingMs: 2, takeoverMs: 40 });
		const leader = browsing.tab();
		const follower = browsing.tab();
		await settle();

		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(leader.link.leading).toBe(true);
		expect(follower.link.leading).toBe(false);
		expect(browsing.opened).toEqual(['/api/stream']);
	});
});

describe('a tab with nothing left to serve', () => {
	it('gives the lock back so another tab can take it', async () => {
		const browsing = browser();
		const first = browsing.tab();
		await settle();

		first.held.close();
		const second = browsing.tab();
		await settle();

		expect(second.link.leading).toBe(true);
		expect(browsing.opened).toHaveLength(2);
	});
});

describe('when the election itself is unusable', () => {
	it('connects anyway rather than leaving the tab deaf', () => {
		const bus = new FakeBus();
		const opened: string[] = [];
		const link = new LeaderLink({
			locks: {
				request() {
					// What a browser that refuses the api looks like from here.
					throw new Error('SecurityError');
				}
			},
			channel: () => bus.open(),
			connect: () =>
				new DirectLink((url) => {
					opened.push(url);
					return new FakeStream();
				})
		});
		const stream = new SharedStream(link);

		const held = stream.subscribe({ types: ['update.created'], listener: () => {} });

		expect(opened).toEqual(['/api/stream']);
		expect(stream.connected).toBe(true);
		held.close();
	});

	it('does not ask again for a lock it was refused', async () => {
		const bus = new FakeBus();
		let asked = 0;
		const link = new LeaderLink({
			locks: {
				request() {
					asked += 1;
					return Promise.reject(new Error('NotSupportedError'));
				}
			},
			channel: () => bus.open(),
			connect: () => new DirectLink(() => new FakeStream())
		});
		const stream = new SharedStream(link);
		const held = stream.subscribe({ types: ['update.created'], listener: () => {} });

		await settle();

		expect(asked).toBe(1);
		held.close();
	});
});

describe('choosing a link for the platform', () => {
	it('shares one connection where the browser can elect a leader', () => {
		const bus = new FakeBus();

		expect(
			browserLink(undefined, { locks: new FakeLocks(), channel: () => bus.open() })
		).toBeInstanceOf(LeaderLink);
	});

	it('keeps its own connection where it cannot', () => {
		// A page served over plain http to a hostname rather than to localhost is
		// not a secure context, and Web Locks is not there at all.
		expect(browserLink(undefined, { channel: () => new FakeBus().open() })).toBeInstanceOf(
			DirectLink
		);
		expect(browserLink(undefined, { locks: new FakeLocks() })).toBeInstanceOf(DirectLink);
		expect(browserLink(undefined, {})).toBeInstanceOf(DirectLink);
	});
});
