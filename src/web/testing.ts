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
import type { ProjectView, SnapshotResponse, UpdateView } from './types';
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
				updates: page()
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
			const body: SnapshotResponse = {
				seq: state.seq,
				at: new Date().toISOString(),
				updates: page(),
				...(url.startsWith('/api/snapshot?') || url === '/api/snapshot'
					? { projects: state.projects }
					: {})
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
