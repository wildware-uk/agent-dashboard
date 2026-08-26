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

/** Media a card can carry (design §3, §6). */
export type MediaKind = 'image' | 'video';

/**
 * Where a media item is in the pipeline (design §6).
 *
 * `pending` is a placeholder, `failed` is a stated failure, and only `ready`
 * has anything to render. The browser never guesses from a missing file.
 */
export type MediaStatus = 'pending' | 'ready' | 'failed';

/**
 * Every address `/media/:id/:variant` answers (design §6).
 *
 * Re-declared here rather than imported from `$media`, for the reason at the top
 * of this file: this module ships to the browser. The set is pinned by
 * `media.test.ts` against the server's own list, which is the copy that would
 * otherwise rot.
 */
export type MediaVariant = 'original' | 'thumb-640' | 'thumb-1600' | 'poster' | 'video';

/**
 * One attachment, as the timeline snapshot sends it.
 *
 * No URLs: an address is `/media/:id/:variant` everywhere, so `variants` — the
 * addresses that will actually answer right now — is all the browser needs, and
 * it is what stops the grid asking for a transcode a web-playable mp4 never got
 * (`src/media/derive.ts`). `width` and `height` are the stored dimensions, which
 * is what lets a cell reserve its box before the bytes load.
 */
export type MediaView = {
	id: string;
	updateId: string | null;
	kind: MediaKind;
	mime: string;
	status: MediaStatus;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	variants: MediaVariant[];
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
	/**
	 * The media grid's contents, in upload order (design §7).
	 *
	 * Optional only because a card is renderable without it — a spec builds one
	 * from three fields, and an update posted before this field existed is a
	 * plain-text card either way. Every real response carries an array, empty
	 * included.
	 */
	media?: MediaView[];
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
 * `projects` and `agentNames` are absent from the updates-only endpoint, which
 * is exactly why they are optional here rather than in a second type.
 */
export type SnapshotResponse = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	projects?: ProjectView[];
	updates: UpdatesPage;
	/**
	 * Agent id to display name, for every agent this deployment knows — the
	 * offline and the revoked included, because that is who most of a timeline
	 * was posted by.
	 */
	agentNames?: Record<string, string>;
};

/** Where a task is in its life (design §3). */
export type TaskState = 'todo' | 'claimed' | 'done' | 'cancelled';

/**
 * One task as `GET /api/snapshot/tasks` sends it.
 *
 * `body` is the brief the owner wrote and `result` is what the agent reported,
 * so both are untrusted text as far as rendering goes — they are shown as text,
 * never as markup, for the same reason an update's markdown renders with raw HTML
 * disabled (design §8).
 */
export type TaskView = {
	id: string;
	seq: number;
	projectId: string;
	/** The claimant, or the agent the owner targeted it at, or `null`. */
	agentId: string | null;
	title: string;
	body: string;
	state: TaskState;
	createdAt: number;
	claimedAt: number | null;
	doneAt: number | null;
	result: string | null;
};

/** `GET /api/snapshot/tasks`. */
export type TasksSnapshot = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	tasks: TaskView[];
};

/**
 * One message as `GET /api/messages` sends it (design §3, §7).
 *
 * `author` is the literal `human` or `agent:<agent_id>`, which is a string
 * rather than an id because the owner is not a row in a single-owner
 * deployment. `body` is markdown and untrusted like any other body on this page:
 * it goes through the same renderer with raw HTML disabled (design §8), which
 * `Thread.svelte.spec.ts` asserts in a real browser.
 */
export type MessageView = {
	id: string;
	seq: number;
	projectId: string | null;
	updateId: string | null;
	taskId: string | null;
	author: string;
	body: string;
	createdAt: number;
};

/** `GET /api/messages`: every thread in scope, stamped with the cursor it is good to. */
export type MessagesSnapshot = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	/** Oldest first: a conversation is read downwards. */
	messages: MessageView[];
};
