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
import type { MediaView, ProjectView, SnapshotResponse, UpdateView } from './types';
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
	private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

	addEventListener(type: string, listener: (event: MessageEvent) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
	}

	/** Deliver one frame, serialised the way the server serialises it. */
	emit(type: string, envelope: { seq: number; payload?: unknown } & Record<string, unknown>): void {
		const data = JSON.stringify({ type, at: new Date().toISOString(), ...envelope });
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data } as MessageEvent);
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
				agentNames: state.agentNames ?? {}
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
			patchProject: (reference, patch) =>
				record('patchProject', [reference, patch], aProject({ slug: reference, ...patch })),
			setUpdatePinned: (id, pinned) =>
				record('setUpdatePinned', [id, pinned], anUpdate({ id, pinned })),
			deleteUpdate: (id) => record('deleteUpdate', [id], anUpdate({ id, deletedAt: 1 }))
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
