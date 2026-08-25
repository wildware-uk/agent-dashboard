/**
 * The shapes the browser receives over the HTTP API.
 *
 * `src/web/` ships to the browser and may not import `$db` or `$domain`
 * (design §2, enforced by `src/architecture.test.ts`), so the wire format is
 * declared here rather than borrowed from a server type. That is a deliberate
 * copy of three row shapes, and the reason it cannot silently rot is that
 * `src/http/stream/snapshot.ts` derives its own types from the domain functions:
 * a field that changes name there changes the JSON, and the component tests and
 * the shell e2e both read these fields by name.
 *
 * Timestamps are epoch milliseconds, as everywhere else in the tree.
 */

/** The four card colours (design §7). */
export type UpdateLevel = 'info' | 'success' | 'warn' | 'error';

export type ProjectStatus = 'active' | 'archived';

/** A project as the sidebar renders it. */
export type ProjectView = {
	id: string;
	seq: number;
	slug: string;
	name: string;
	description: string | null;
	status: ProjectStatus;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
};

/** One update as a card renders it. `body` is untrusted markdown (design §8). */
export type UpdateView = {
	id: string;
	seq: number;
	projectId: string;
	agentId: string;
	sessionId: string | null;
	title: string | null;
	body: string;
	level: UpdateLevel;
	pinned: boolean;
	createdAt: number;
	deletedAt: number | null;
};

/** The timeline page inside a snapshot response. */
export type UpdatesPage = {
	items: UpdateView[];
	/** Pass back as `cursor` to page further into the past. `null` at the end. */
	nextCursor: string | null;
	hasMore: boolean;
};

/**
 * `GET /api/snapshot` and `GET /api/snapshot/updates`.
 *
 * `projects` is absent from the updates-only endpoint, which is exactly why it
 * is optional here rather than in a second type.
 */
export type SnapshotResponse = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	projects?: ProjectView[];
	updates: UpdatesPage;
};
