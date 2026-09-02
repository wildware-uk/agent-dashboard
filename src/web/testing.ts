/**
 * Test-only doubles for the client store.
 *
 * A second entry point, deliberately not re-exported from `./index.ts`: it is
 * imported by `timeline.test.ts` (node) and by the component specs (browser), so
 * both drive the store through the same fake server rather than each inventing
 * one.
 *
 * The fakes model what the real endpoints actually do — a snapshot stamped with
 * the seq it is good to, and events that carry identifiers rather than data
 * (design §4) — because a double that is more generous than the server would
 * hide exactly the bugs these tests exist to catch.
 */
import type {
	AckView,
	MediaView,
	MessageView,
	MessagesSnapshot,
	ProjectView,
	RequestView,
	RequestsSnapshot,
	SnapshotResponse,
	TaskView,
	TasksSnapshot,
	UpdateView
} from './types';
import type { OwnerActions } from './actions';
import type { AgentsSnapshot, LiveAgentView } from './presence.svelte';
import type { StreamLike } from './timeline.svelte';

/** A project row with sensible defaults. */
export function aProject(overrides: Partial<ProjectView> = {}): ProjectView {
	return {
		id: 'p1',
		seq: 1,
		slug: 'agent-dashboard',
		name: 'Agent Dashboard',
		description: null,
		status: 'active',
		pinned: false,
		createdAt: Date.UTC(2026, 7, 25, 9),
		updatedAt: Date.UTC(2026, 7, 25, 9),
		...overrides
	};
}

/** An update row with sensible defaults. */
export function anUpdate(overrides: Partial<UpdateView> = {}): UpdateView {
	return {
		id: 'u1',
		seq: 1,
		projectId: 'p1',
		agentId: 'a1',
		sessionId: null,
		title: null,
		body: 'shipped it',
		level: 'info',
		pinned: false,
		createdAt: Date.UTC(2026, 7, 25, 10),
		deletedAt: null,
		...overrides
	};
}

/**
 * A media attachment with sensible defaults: a ready image with both thumbnails.
 *
 * The default is the case the grid renders, so a spec that cares about a
 * placeholder or a failure has to say so — which is the right way round, because
 * those two are the states most easily faked by never testing them.
 */
export function aMedia(overrides: Partial<MediaView> = {}): MediaView {
	return {
		id: 'm1',
		updateId: 'u1',
		kind: 'image',
		mime: 'image/png',
		status: 'ready',
		width: 1200,
		height: 800,
		durationMs: null,
		variants: ['original', 'thumb-640', 'thumb-1600'],
		...overrides
	};
}

/** An `EventSource` stand-in a test drives by hand. */
export class FakeStream implements StreamLike {
	url = '';
	closed = false;
	private readonly handlers = new Map<string, Set<(event: MessageEvent) => void>>();

	/**
	 * How many listeners are attached, across every type.
	 *
	 * A connection is only released when nothing is still listening to it, so
	 * this is what a leak looks like from the outside: a closed stream with
	 * handlers still on it.
	 */
	get listeners(): number {
		let count = 0;
		for (const set of this.handlers.values()) count += set.size;
		return count;
	}

	addEventListener(type: string, listener: (event: MessageEvent) => void): void {
		const set = this.handlers.get(type) ?? new Set();
		set.add(listener);
		this.handlers.set(type, set);
	}

	removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
		this.handlers.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
	}

	/** Deliver one frame, serialised the way the server serialises it. */
	emit(type: string, envelope: { seq: number; payload?: unknown } & Record<string, unknown>): void {
		const data = JSON.stringify({ type, at: new Date().toISOString(), ...envelope });
		for (const listener of [...(this.handlers.get(type) ?? [])]) {
			listener({ data, lastEventId: String(envelope.seq) } as MessageEvent);
		}
	}

	/** Deliver a bare event with no body: what `open` and `error` are. */
	fire(type: 'open' | 'error'): void {
		for (const listener of [...(this.handlers.get(type) ?? [])]) {
			listener({} as MessageEvent);
		}
	}
}

export type FakeApiState = {
	seq: number;
	projects: ProjectView[];
	items: UpdateView[];
	hasMore?: boolean;
	/** Agent id to display name, as the full snapshot carries it. */
	agentNames?: Record<string, string>;
	/** The threads the server render embeds, so a card paints with its replies. */
	messages?: MessageView[];
	/** What agents have said about those messages (migration 013). */
	acks?: AckView[];
};

/**
 * A fake `/api/snapshot` pair plus the scheduling hook the store coalesces
 * through, so a test can say "now run the refetch you queued".
 */
export function fakeApi(initial: FakeApiState) {
	let state: FakeApiState = { hasMore: false, ...initial };
	const calls: string[] = [];
	const queue: (() => void)[] = [];

	const page = () => ({
		items: state.items,
		hasMore: state.hasMore === true,
		nextCursor: state.hasMore === true ? String(state.items.at(-1)?.seq ?? 0) : null
	});

	return {
		calls,
		queue,

		/** What the server render would have embedded in the page. */
		snapshot(): SnapshotResponse {
			return {
				seq: state.seq,
				at: new Date().toISOString(),
				projects: state.projects,
				updates: page(),
				agentNames: state.agentNames ?? {},
				...(state.messages ? { messages: state.messages } : {}),
				...(state.acks ? { acks: state.acks } : {})
			};
		},

		/** A new update lands on the server, bumping the stream cursor. */
		publish(update: UpdateView): void {
			state = { ...state, items: [update, ...state.items], seq: update.seq };
		},

		/** The server's state as a whole is now this. */
		replace(next: Partial<FakeApiState>): void {
			state = { ...state, ...next };
		},

		setProjects(projects: ProjectView[]): void {
			state = { ...state, projects };
		},

		fetch(url: string): Promise<Response> {
			calls.push(url);
			// Only the full snapshot carries the project list and the agent names;
			// `/api/snapshot/updates` is a page of the timeline and nothing else, so
			// a store that expected either from it would be wrong against the real
			// endpoint.
			const full = url.startsWith('/api/snapshot?') || url === '/api/snapshot';
			const body: SnapshotResponse = {
				seq: state.seq,
				at: new Date().toISOString(),
				updates: page(),
				...(full ? { projects: state.projects, agentNames: state.agentNames ?? {} } : {})
			};
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		},

		/**
		 * Run every coalesced refetch and let its promises settle.
		 *
		 * Both a microtask and a macrotask turn per pass: reading a `Response`
		 * body resolves on the task queue in a browser, not just the microtask
		 * queue, so awaiting promises alone would return before the store had
		 * applied anything.
		 */
		async settle(): Promise<void> {
			for (let pass = 0; pass < 5; pass += 1) {
				while (queue.length > 0) queue.shift()!();
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	};
}

/** One call a control made, so a spec can assert what it asked the server for. */
export type ActionCall = { name: string; args: unknown[] };

/**
 * A stand-in for {@link OwnerActions}.
 *
 * Records what a control asked for and answers with the row the endpoint would
 * have returned, so a spec drives real clicks with no server and no `fetch`.
 * `fail` makes the next call reject the way {@link ActionError} does, which is
 * the case a control has to survive without losing what the owner typed.
 */
export function fakeActions(): {
	calls: ActionCall[];
	fail(error: Error): void;
	actions: OwnerActions;
} {
	const calls: ActionCall[] = [];
	let failure: Error | null = null;

	function record<T>(name: string, args: unknown[], result: T): Promise<T> {
		calls.push({ name, args });
		return failure ? Promise.reject(failure) : Promise.resolve(result);
	}

	return {
		calls,
		fail(error: Error) {
			failure = error;
		},
		actions: {
			createProject: (input) =>
				record('createProject', [input], aProject({ id: 'new', name: input.name })),
			patchProject: (reference, patch) => {
				// `theme` is the one field whose patch shape differs from the row's: a
				// patch may say `null` for a field to clear it, and a row never can.
				// The server resolves that; the double just records the call.
				const { theme, ...fields } = patch;
				return record(
					'patchProject',
					[reference, patch],
					// A patch's `theme` may say `null` for a field to clear it and a row
					// never can, so the double reports the row unthemed unless the patch
					// set a whole theme. Resolving the merge is the server's job.
					aProject({
						slug: reference,
						...fields,
						...(theme ? { theme: { background: theme.background ?? undefined } } : {})
					})
				);
			},
			setUpdatePinned: (id, pinned) =>
				record('setUpdatePinned', [id, pinned], anUpdate({ id, pinned })),
			deleteUpdate: (id) => record('deleteUpdate', [id], anUpdate({ id, deletedAt: 1 })),
			createTask: (input) =>
				record(
					'createTask',
					[input],
					aTask({
						id: 'new',
						title: input.title,
						agentId: input.agentId ?? null,
						// The server stamps a broadcast as it inserts; the double reports
						// the row the same way rather than dropping the field.
						broadcastAt: input.broadcast ? 1 : null
					})
				),
			patchTask: (id, patch) => {
				// `broadcast` is a verb, not a column: the row answers with the stamp
				// the server wrote, so the double translates it the same way.
				const { broadcast, ...fields } = patch;
				return record(
					'patchTask',
					[id, patch],
					aTask({
						id,
						...fields,
						...(broadcast === undefined ? {} : { broadcastAt: broadcast ? 1 : null })
					})
				);
			},
			markProjectSeen: (reference) =>
				record('markProjectSeen', [reference], aProject({ slug: reference })),
			markRepliesSeen: (id) => record('markRepliesSeen', [id], anUpdate({ id, repliesSeenAt: 1 })),
			renameAgent: (id, name) => record('renameAgent', [id, name], { id, name }),
			uploadMedia: (file) =>
				record('uploadMedia', [file.name], aMedia({ id: `m-${file.name}`, status: 'ready' })),
			postMessage: (input) =>
				record(
					'postMessage',
					[input],
					aMessage({ id: 'new', body: input.body, updateId: input.update ?? null })
				),
			deleteMessage: (id) => record('deleteMessage', [id], aMessage({ id })),
			answerRequest: (id, value) =>
				record(
					'answerRequest',
					[id, value],
					aRequest({ id, state: 'answered', answer: { kind: 'confirm', value } })
				),
			dismissRequest: (id) => record('dismissRequest', [id], aRequest({ id, state: 'cancelled' })),
			shareUpdate: (id) =>
				record('shareUpdate', [id], { url: `https://dash.test/s/token-for-${id}` }),
			revokeShare: (id) => record('revokeShare', [id], { revoked: true })
		}
	};
}

/** A pending owner request with sensible defaults: a confirm, nobody waiting on it yet. */
export function aRequest(overrides: Partial<RequestView> = {}): RequestView {
	return {
		id: 'r1',
		seq: 1,
		agentId: 'a1',
		projectId: 'p1',
		updateId: null,
		kind: 'confirm',
		question: 'Push to main?',
		detail: null,
		options: null,
		config: null,
		state: 'pending',
		expiresAt: Date.UTC(2026, 7, 25, 12),
		answeredAt: null,
		answer: null,
		...overrides
	};
}

/**
 * A fake `GET /api/snapshot/requests` plus the scheduling hook the banner's
 * store coalesces through.
 *
 * Wholesale, like the task and presence doubles: the endpoint answers with what
 * is outstanding right now, so a test says what the server holds rather than
 * publishing a delta.
 */
export function fakeRequestsApi(initial: { seq?: number; requests?: RequestView[] } = {}) {
	let seq = initial.seq ?? 1;
	let requests = initial.requests ?? [];
	const calls: string[] = [];
	const queue: (() => void)[] = [];
	let status = 200;

	return {
		calls,
		queue,

		snapshot(): RequestsSnapshot {
			return { seq, at: new Date().toISOString(), requests };
		},

		/** The server's answer is now this, at this stream cursor. */
		replace(next: RequestView[], nextSeq = seq + 1): void {
			requests = next;
			seq = nextSeq;
		},

		/** Make the next reads fail the way a dropped session or a restart would. */
		breaks(nextStatus = 500): void {
			status = nextStatus;
		},

		fetch(url: string): Promise<Response> {
			calls.push(url);
			if (status !== 200) return Promise.resolve(new Response('no', { status }));
			return Promise.resolve(
				new Response(JSON.stringify({ seq, at: new Date().toISOString(), requests }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		},

		/** Run every coalesced refetch and let its promises settle. */
		async settle(): Promise<void> {
			for (let pass = 0; pass < 5; pass += 1) {
				while (queue.length > 0) queue.shift()!();
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	};
}

/** A live agent as `GET /api/snapshot/agents` sends it. */
export function aLiveAgent(overrides: Partial<LiveAgentView> = {}): LiveAgentView {
	return {
		agentId: 'a1',
		name: 'scout',
		sessionId: 's1',
		startedAt: Date.UTC(2026, 7, 25, 10),
		lastHeartbeatAt: Date.UTC(2026, 7, 25, 10),
		sessions: 1,
		host: 'wildware',
		cwd: '/srv/ssd1/app',
		model: 'opus',
		...overrides
	};
}

/**
 * A fake `/api/snapshot/agents` plus the scheduling hook the presence store
 * coalesces through.
 *
 * Presence has no pages and no filters, so this is deliberately simpler than
 * {@link fakeApi}: the endpoint answers with whoever is online at the instant it
 * is asked, which is exactly what `agents` is.
 */
export function fakeAgentsApi(initial: { seq?: number; agents?: LiveAgentView[] } = {}) {
	let seq = initial.seq ?? 1;
	let agents = initial.agents ?? [];
	const calls: string[] = [];
	const queue: (() => void)[] = [];
	let status = 200;

	return {
		calls,
		queue,

		snapshot(): AgentsSnapshot {
			return { seq, at: new Date().toISOString(), agents };
		},

		/** The server's answer is now this, at this stream cursor. */
		replace(next: LiveAgentView[], nextSeq = seq + 1): void {
			agents = next;
			seq = nextSeq;
		},

		/** Make the next reads fail the way a dropped session or a restart would. */
		breaks(nextStatus = 500): void {
			status = nextStatus;
		},

		fetch(url: string): Promise<Response> {
			calls.push(url);
			if (status !== 200) return Promise.resolve(new Response('no', { status }));
			return Promise.resolve(
				new Response(JSON.stringify({ seq, at: new Date().toISOString(), agents }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		},

		/** Run every coalesced refetch and let its promises settle. */
		async settle(): Promise<void> {
			for (let pass = 0; pass < 5; pass += 1) {
				while (queue.length > 0) queue.shift()!();
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	};
}

/** A task row with sensible defaults: on the queue, unassigned. */
export function aTask(overrides: Partial<TaskView> = {}): TaskView {
	return {
		id: 't1',
		seq: 1,
		projectId: 'p1',
		agentId: null,
		title: 'Ship the task list',
		body: 'todo, claimed, done. No drag and drop.',
		state: 'todo',
		createdAt: Date.UTC(2026, 7, 25, 9, 30),
		claimedAt: null,
		doneAt: null,
		result: null,
		broadcastAt: null,
		...overrides
	};
}

/**
 * A fake `GET /api/snapshot/tasks` plus the scheduling hook the task store
 * coalesces through.
 *
 * Like the presence double and unlike the timeline's, the answer is wholesale:
 * the endpoint sends the list as it stands, so a test says what the server now
 * holds rather than publishing a delta.
 */
export function fakeTasksApi(initial: { seq?: number; tasks?: TaskView[]; acks?: AckView[] } = {}) {
	let seq = initial.seq ?? 1;
	let tasks = initial.tasks ?? [];
	const acks = initial.acks ?? [];
	const calls: string[] = [];
	const queue: (() => void)[] = [];
	let status = 200;

	return {
		calls,
		queue,

		snapshot(): TasksSnapshot {
			return { seq, at: new Date().toISOString(), tasks, acks };
		},

		/** The server's answer is now this, at this stream cursor. */
		replace(next: TaskView[], nextSeq = seq + 1): void {
			tasks = next;
			seq = nextSeq;
		},

		/** Make the next reads fail the way a dropped session or a restart would. */
		breaks(nextStatus = 500): void {
			status = nextStatus;
		},

		fetch(url: string): Promise<Response> {
			calls.push(url);
			if (status !== 200) return Promise.resolve(new Response('no', { status }));
			return Promise.resolve(
				new Response(JSON.stringify({ seq, at: new Date().toISOString(), tasks, acks }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		},

		/** Run every coalesced refetch and let its promises settle. */
		async settle(): Promise<void> {
			for (let pass = 0; pass < 5; pass += 1) {
				while (queue.length > 0) queue.shift()!();
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	};
}

/**
 * An acknowledgement with sensible defaults: an agent saying it is on the
 * default message (migration 013).
 */
export function anAck(overrides: Partial<AckView> = {}): AckView {
	return {
		id: 'ack1',
		seq: 1,
		agentId: 'a1',
		messageId: 'msg1',
		taskId: null,
		state: 'thinking',
		createdAt: Date.UTC(2026, 7, 25, 11, 1),
		updatedAt: Date.UTC(2026, 7, 25, 11, 1),
		...overrides
	};
}

/** A message with sensible defaults: the owner's reply on the default card. */
export function aMessage(overrides: Partial<MessageView> = {}): MessageView {
	return {
		id: 'msg1',
		seq: 1,
		projectId: 'p1',
		updateId: 'u1',
		taskId: null,
		author: 'human',
		body: 'nice one',
		createdAt: Date.UTC(2026, 7, 25, 11),
		replyTo: null,
		...overrides
	};
}

/**
 * A fake `GET /api/messages` plus the scheduling hook the thread store
 * coalesces through.
 *
 * Like the real endpoint it answers with every message in scope, oldest first,
 * stamped with the stream cursor it is good to — so a store that assumed one
 * request per card, or newest-first, would be wrong here as well as in
 * production.
 */
export function fakeMessagesApi(
	initial: { seq?: number; messages?: MessageView[]; acks?: AckView[] } = {}
) {
	let seq = initial.seq ?? 1;
	let messages = initial.messages ?? [];
	let acks = initial.acks ?? [];
	const calls: string[] = [];
	const queue: (() => void)[] = [];
	let status = 200;

	return {
		calls,
		queue,

		snapshot(): MessagesSnapshot {
			return { seq, at: new Date().toISOString(), messages, acks };
		},

		/** An agent said something about a message, bumping the stream cursor. */
		acknowledge(ack: AckView): void {
			acks = [...acks.filter((held) => held.id !== ack.id), ack];
			seq = ack.seq;
		},

		/** Somebody posted, on the server, bumping the stream cursor. */
		publish(message: MessageView): void {
			messages = [...messages, message];
			seq = message.seq;
		},

		/** Make the next reads fail the way a dropped session or a restart would. */
		breaks(nextStatus = 500): void {
			status = nextStatus;
		},

		fetch(url: string): Promise<Response> {
			calls.push(url);
			if (status !== 200) return Promise.resolve(new Response('no', { status }));
			return Promise.resolve(
				new Response(JSON.stringify({ seq, at: new Date().toISOString(), messages, acks }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		},

		/** Run every coalesced refetch and let its promises settle. */
		async settle(): Promise<void> {
			for (let pass = 0; pass < 5; pass += 1) {
				while (queue.length > 0) queue.shift()!();
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	};
}
