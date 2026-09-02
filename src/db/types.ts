/**
 * The shapes the repositories return (design §3).
 *
 * Column names are camelCased and the two encoded columns are decoded — 0/1
 * becomes `boolean`, a JSON text column becomes an object — so no caller has to
 * remember which columns SQLite stores narrowly. Nothing else is interpreted:
 * these are rows, not domain objects.
 *
 * Timestamps are milliseconds since the epoch throughout.
 */

/** Common to every table: the exposed id and the ordering key. */
export type Keyed = {
	/** ULID. Sortable, stable, safe to expose. */
	id: string;
	/** Autoincrementing cursor / event-ordering key. Never reused. */
	seq: number;
};

export type ProjectStatus = 'active' | 'archived';

/**
 * A project's own styling (design §7).
 *
 * Every field optional and the whole thing nullable: a project without a theme
 * is the ordinary dashboard, which is what almost all of them are.
 *
 * The two colours are `#rrggbb` literals, normalised by `$domain` on the way in.
 * They reach a CSS custom property, so nothing else is ever allowed into them —
 * see `src/domain/projects.ts`, which is the only place that decides.
 */
export type ProjectTheme = {
	/** The page surface. */
	background?: string;
	/** Buttons and links: what the dashboard calls its accent. */
	accent?: string;
	/** A `media` row, shown beside the project name. Never an external URL. */
	logoMediaId?: string;
	/**
	 * Show the logo *instead of* the project name, for a logo that is the name.
	 *
	 * The name does not disappear when this is set — it becomes the image's alt
	 * text, so a screen reader still reads it and the tab title is unchanged. A
	 * wordmark is a picture of a name, and the accessible tree should not lose the
	 * name just because the pixels carry it.
	 */
	logoReplacesName?: boolean;
};

/**
 * One column of a project's task board (design §7).
 *
 * A title the owner chose, and the task states it gathers. Two columns may not
 * claim the same state — a task would be in both, and dragging it out of one
 * would leave it in the other.
 */
export type BoardColumn = { title: string; states: TaskState[] };

/** How the owner wants a project's tasks laid out. */
export type ProjectBoard = { columns: BoardColumn[] };

export type Project = Keyed & {
	slug: string;
	name: string;
	description: string | null;
	status: ProjectStatus;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
	/** Per-project styling, or `null` for the dashboard's own (design §7). */
	theme: ProjectTheme | null;
	/** The board's columns, or `null` for the default three (design §7). */
	board: ProjectBoard | null;
	/**
	 * When the owner last opened this project, or `null` for never.
	 *
	 * `null` is not the epoch: a project the owner has never opened badges its
	 * whole history rather than nothing.
	 */
	ownerSeenAt: number | null;
};

export type Agent = Keyed & {
	name: string;
	/** HMAC-SHA256 of the agent's bearer token (design §8). Never the token. */
	tokenHash: string;
	createdAt: number;
	revokedAt: number | null;
	lastSeenAt: number | null;
};

/** Free-form client detail an agent reports when it registers a session. */
export type SessionMeta = { host?: string; cwd?: string; model?: string } & Record<string, unknown>;

export type Session = Keyed & {
	agentId: string;
	startedAt: number;
	lastHeartbeatAt: number;
	endedAt: number | null;
	meta: SessionMeta | null;
};

export type UpdateLevel = 'info' | 'success' | 'warn' | 'error';

/**
 * How much the owner needs to care now (design §7).
 *
 * A different axis from {@link UpdateLevel}: level is what happened, priority is
 * whether it can wait. A routine `error` from a flaky test is low priority; an
 * `info` that a migration is about to run against production is high.
 */
export type UpdatePriority = 'low' | 'medium' | 'high';

export type Update = Keyed & {
	projectId: string;
	agentId: string;
	sessionId: string | null;
	title: string | null;
	/** Markdown, authored by an agent, therefore untrusted (design §8). */
	body: string;
	level: UpdateLevel;
	pinned: boolean;
	createdAt: number;
	/** Deletes are soft, so a browser can be told to drop a rendered row. */
	deletedAt: number | null;
	/** When the posting agent last corrected it, or `null` if it never has. */
	editedAt: number | null;
	/** How much this needs the owner now. `medium` unless the agent said (§7). */
	priority: UpdatePriority;
	/** The task this is progress on, or `null` — most updates are not (§3). */
	taskId: string | null;
	/**
	 * When the owner last read the conversation on this card (migration 015).
	 *
	 * `null` for never, which is what keeps a card in "Recent replies" while its
	 * thread is unread.
	 */
	repliesSeenAt: number | null;
};

export type MediaKind = 'image' | 'video';
export type MediaStatus = 'pending' | 'ready' | 'failed';

export type Media = Keyed & {
	/** The agent that uploaded it, or `null` for the owner's own (migration 016). */
	agentId: string | null;
	/** Who posted it: `human`, or `agent:<agent_id>` — the vocabulary messages use. */
	author: string;
	/** Null until an update references it: upload precedes the post (design §3). */
	updateId: string | null;
	/** The message this hangs off, for an image in a reply or one of the owner's posts. */
	messageId: string | null;
	kind: MediaKind;
	mime: string;
	bytes: number;
	sha256: string;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	status: MediaStatus;
	createdAt: number;
};

export type DerivativeKind = 'thumb' | 'poster' | 'mp4';

export type Derivative = Keyed & {
	mediaId: string;
	kind: DerivativeKind;
	/** Path relative to the media root. Callers never build paths themselves. */
	path: string;
	bytes: number;
	width: number | null;
	height: number | null;
};

export type UploadToken = Keyed & {
	agentId: string;
	mediaId: string;
	maxBytes: number;
	/** Mime types this token accepts. */
	mimeAllow: string[];
	expiresAt: number;
	/** Set the moment the token is spent: upload tokens are single use. */
	usedAt: number | null;
};

/**
 * What an agent is telling the owner about one message or task.
 *
 * Three states, for the three answers a silent card can owe its owner: has
 * anybody seen this, is anybody on it, is it finished. `thinking` is a claim
 * about *now* and reads as stale the moment the agent goes away, which is why
 * the dashboard shows it only while that agent is online; `read` and `done` are
 * facts about the past and stay.
 *
 * `read` was added because of how the other two were used rather than how they
 * were designed: agents would say `thinking` and never close it, because `done`
 * felt like a claim about the work rather than about the message. "I have seen
 * this" is the smaller, truer thing they were reaching for.
 */
export type AckState = 'thinking' | 'read' | 'done';

export type Acknowledgement = Keyed & {
	agentId: string;
	/** Exactly one of these two is set. */
	messageId: string | null;
	taskId: string | null;
	state: AckState;
	/** When the agent first said anything about this. */
	createdAt: number;
	/** When it last changed its mind. Equal to `createdAt` until it does. */
	updatedAt: number;
};

export type TaskState = 'todo' | 'claimed' | 'done' | 'cancelled';

export type Task = Keyed & {
	projectId: string;
	agentId: string | null;
	title: string;
	body: string;
	state: TaskState;
	createdAt: number;
	claimedAt: number | null;
	doneAt: number | null;
	result: string | null;
	/**
	 * When the owner sent this task out to the project's agents, or `null`.
	 *
	 * Unassigned work is nobody's, so it notifies nobody. This is the owner
	 * saying "somebody on this project take it", which is a different thing from
	 * a task that merely happens to have no assignee.
	 */
	broadcastAt: number | null;
};

export type Message = Keyed & {
	projectId: string | null;
	updateId: string | null;
	taskId: string | null;
	/**
	 * The message this answers, for the owner's own feed posts (migration 014).
	 *
	 * One level only: a reply names a post, never another reply.
	 */
	replyTo: string | null;
	/** Either the literal `human` or `agent:<agent_id>` (design §3). */
	author: string;
	body: string;
	createdAt: number;
	/**
	 * When it was deleted, or `null` for a live message (migration 017).
	 *
	 * Soft, as an update's delete is: the row survives so every browser that
	 * already rendered the line can be told to drop it.
	 */
	deletedAt: number | null;
};

/**
 * One message, handed to one agent (migration 018).
 *
 * Delivery is a fact about a pair rather than about a message: several agents
 * work in one project and each is told separately. It is also not "read" —
 * only `get_messages` moves a read cursor, and a message an agent was handed
 * and never looked at is precisely the state worth seeing.
 */
export type MessageDelivery = Keyed & {
	messageId: string;
	agentId: string;
	deliveredAt: number;
	/**
	 * The connection it was handed to (migration 019), or `null` for one that
	 * named none.
	 *
	 * Two sessions can share a bearer token, so "delivered" had to stop being a
	 * fact about the agent: one of them was consuming the only delivery there
	 * was and the other went silent.
	 */
	clientId: string | null;
};

export type ReadCursor = Keyed & {
	agentId: string;
	lastSeenMessageSeq: number;
};

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'timeout' | 'cancelled';

/** The shapes an owner request can take (design §5). */
export type RequestKind = 'text' | 'confirm' | 'buttons' | 'choice' | 'multi_choice' | 'form';

/**
 * A `form` answer: which action the owner took, and the text as they left it.
 *
 * The two travel together because they are one decision. "Approve" on its own
 * says nothing about *what* was approved when the owner has just rewritten it,
 * and the edited text on its own does not say whether to send it.
 */
export type RequestFormValue = { action: string; text: string };

/** What an answer carries, by kind: text a string, confirm a boolean, lists strings. */
export type RequestValue = string | boolean | string[] | RequestFormValue;

/**
 * A settled request's answer.
 *
 * Stored as one JSON column rather than spread over typed columns, because the
 * type of `value` is a function of `kind` and SQLite has no union column. Reading
 * it back is `kind`-first, which is how an agent narrows it too.
 */
export type RequestAnswer = { kind: RequestKind; value: RequestValue };

/**
 * The kind-specific knobs, as stored in `approvals.config`.
 *
 * One JSON column because they travel together and nothing queries on them:
 * `placeholder` and `multiline` shape a text box, `default` pre-fills a control,
 * and `min`/`max` bound a multi-choice's selection count or a text answer's
 * length.
 */
export type RequestConfig = {
	placeholder?: string;
	multiline?: boolean;
	default?: string;
	min?: number;
	max?: number;
	/** `form`: what to call the editable field, e.g. "Message". */
	label?: string;
};

export type Approval = Keyed & {
	agentId: string;
	projectId: string | null;
	updateId: string | null;
	/**
	 * Which of the five kinds this is (design §5).
	 *
	 * Typed here but not `CHECK`ed in the table: migration 002 appends the column
	 * to a live table, and SQLite cannot add a constraint without rebuilding one.
	 * `$domain` refuses an unknown kind at the write, which is where every row
	 * comes from.
	 */
	kind: RequestKind;
	question: string;
	/** The longer explanation under the question, if the agent wrote one. */
	detail: string | null;
	/** The options the owner is offered, if this kind has any. */
	options: string[] | null;
	/** Kind-specific knobs; see {@link RequestConfig}. */
	config: RequestConfig | null;
	state: ApprovalState;
	expiresAt: number;
	decidedAt: number | null;
	/**
	 * The scalar a decision produced, for reading the table by hand.
	 *
	 * Never the authority: a `multi_choice` answer does not fit in it, so
	 * {@link Approval.answer} is what any code reads.
	 */
	decidedValue: string | null;
	/** The structured answer, and the only complete record of one. */
	answer: RequestAnswer | null;
};
