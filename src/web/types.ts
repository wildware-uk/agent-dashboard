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

/** Whether an update can wait. A different axis from its level (design §7). */
export type UpdatePriority = 'low' | 'medium' | 'high';

export type ProjectStatus = 'active' | 'archived';

/**
 * Per-project styling (design §7).
 *
 * The two colours are `#rrggbb` literals — the server refuses anything else, and
 * `./theme.ts` refuses it again before writing a `style` attribute. Everything
 * else a themed page needs (readable text, borders, raised surfaces) is derived
 * from the background rather than stated here.
 */
export type ProjectTheme = {
	background?: string;
	accent?: string;
	/** A media id, served from this deployment. Never an external URL. */
	logoMediaId?: string;
	/** Show the logo instead of the name. The name becomes the image's alt text. */
	logoReplacesName?: boolean;
};

/** One column of a project's task board (design §7). */
export type BoardColumn = { title: string; states: TaskState[] };

/** How the owner wants a project's tasks laid out, or `null` for the default. */
export type ProjectBoard = { columns: BoardColumn[] };

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
	/** The project's own styling, or `null` for the dashboard's (design §7). */
	theme?: ProjectTheme | null;
	/** The board's columns, or `null` for the default three (design §7). */
	board?: ProjectBoard | null;
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
	/** How much this needs the owner now (design §7). `medium` unless said. */
	priority?: UpdatePriority;
	pinned: boolean;
	createdAt: number;
	deletedAt: number | null;
	/**
	 * When the posting agent last corrected it (design §3).
	 *
	 * Optional for the same reason `media` below is: a card renders without it,
	 * and a spec that builds one from three fields should not have to say "never
	 * edited" to do so.
	 */
	editedAt?: number | null;
	/**
	 * The public link on this card, if the owner made one (design §7, §8).
	 *
	 * Present only when the card is shared. Never the token itself: only its HMAC
	 * is stored, so the URL exists once, in the response to the call that minted
	 * it (`src/domain/shares.ts`).
	 */
	/** The task this update is progress on, if any (design §7). */
	taskId?: string | null;
	/**
	 * When the owner last read this card's thread (migration 015).
	 *
	 * `null` or absent means never, which is what keeps a card in "Recent
	 * replies" while its conversation is unread.
	 */
	repliesSeenAt?: number | null;
	share?: { views: number; sharedAt: number };
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

/**
 * The shapes an owner request takes (design §5).
 *
 * Re-declared here rather than imported from `$domain`, for the reason at the
 * top of this file: this module ships to the browser. `src/web/requests.test.ts`
 * pins the list against the server's own.
 */
export type RequestKind = 'text' | 'confirm' | 'buttons' | 'choice' | 'multi_choice' | 'form';

/** A `form` answer: the action taken, and the text as the owner left it. */
export type RequestFormValue = { action: string; text: string };

/** The kind-specific knobs a control reads: how to render, and what to enforce. */
export type RequestConfig = {
	placeholder?: string;
	multiline?: boolean;
	/** The starting text for `text` and `form`; the pre-picked option otherwise. */
	default?: string;
	/** `multi_choice`: fewest selections. `text` and `form`: shortest answer. */
	min?: number;
	/** `multi_choice`: most selections. `text` and `form`: longest answer. */
	max?: number;
	/** `form`: what to call the editable field. */
	label?: string;
};

/** What the owner said, typed by kind. */
export type RequestAnswer = {
	kind: RequestKind;
	value: string | boolean | string[] | RequestFormValue;
};

/** How a request ended, or that it has not. */
export type RequestState = 'pending' | 'answered' | 'timeout' | 'cancelled';

/**
 * One owner request, as the banner renders it (design §5, §7).
 *
 * `seq` is the queue order: the agent that has been blocked longest is answered
 * first, and it is the server's ordering rather than the banner's.
 */
export type RequestView = {
	id: string;
	seq: number;
	agentId: string;
	projectId: string | null;
	updateId: string | null;
	kind: RequestKind;
	question: string;
	detail: string | null;
	options: string[] | null;
	config: RequestConfig | null;
	state: RequestState;
	expiresAt: number;
	answeredAt: number | null;
	answer: RequestAnswer | null;
};

/**
 * One card as a public share link publishes it (design §7, §8).
 *
 * Deliberately not `UpdateView`. It is a separate, smaller shape so that a field
 * added to the dashboard's card cannot start being published to anyone holding a
 * link — anything that appears here is a decision somebody had to type. No ids
 * that address anything, no agent id, no project slug, and no thread.
 */
export type SharedCardView = {
	update: {
		id: string;
		title: string | null;
		/** Markdown, authored by an agent, therefore untrusted (design §8). */
		body: string;
		level: UpdateLevel;
		createdAt: number;
		editedAt: number | null;
	};
	agentName: string;
	projectName: string | null;
	media: MediaView[];
};

/** `GET /api/snapshot/requests`: everything waiting on the owner right now. */
export type RequestsSnapshot = {
	seq: number;
	at: string;
	requests: RequestView[];
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
	/**
	 * Updates per project id that landed since the owner last opened it — the
	 * sidebar's "new" badge. Absent from the updates-only endpoint, and a project
	 * with nothing new is absent from the map rather than zero.
	 */
	unseen?: Record<string, number>;
	updates: UpdatesPage;
	/**
	 * Agent id to display name, for every agent this deployment knows — the
	 * offline and the revoked included, because that is who most of a timeline
	 * was posted by.
	 */
	agentNames?: Record<string, string>;
	/**
	 * Every thread the page can show, so a card's replies are on screen at first
	 * paint rather than after a fetch on mount. Optional: the paging and scoped
	 * refetch responses carry the timeline alone.
	 */
	messages?: MessageView[];
	/** The acknowledgements on those messages, in the same document as them. */
	acks?: AckView[];
};

/**
 * What an agent is saying about a message or a task, without words
 * (migration 013).
 *
 * `thinking` is a claim about *now*, so the dashboard renders it only while
 * that agent is online; `done` is a fact about the past and stays whatever
 * happened to the agent afterwards.
 */
export type AckState = 'thinking' | 'done';

export type AckView = {
	id: string;
	seq: number;
	agentId: string;
	/** Exactly one of these two is set. */
	messageId: string | null;
	taskId: string | null;
	state: AckState;
	/** When the agent first said anything about this thing. */
	createdAt: number;
	/** When it last changed what it was saying. */
	updatedAt: number;
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
	/**
	 * When the owner sent this out to the project's agents, or `null`.
	 *
	 * Unassigned work is nobody's and notifies nobody; this is the owner offering
	 * it to whoever gets there first, which is a different thing and looks
	 * different on the board.
	 */
	broadcastAt?: number | null;
};

/** `GET /api/snapshot/tasks`. */
export type TasksSnapshot = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	tasks: TaskView[];
	/** What agents have said about these tasks (migration 013). */
	acks?: AckView[];
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
	/**
	 * The owner's own feed post this answers (migration 014).
	 *
	 * A message with no `updateId`, no `taskId` and no `replyTo` is a post: the
	 * owner wrote it straight into the timeline, and it renders as a card of its
	 * own rather than inside somebody else's thread.
	 */
	replyTo?: string | null;
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
	/** The acknowledgements on those messages (migration 013). */
	acks?: AckView[];
};
