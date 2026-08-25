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

export type Project = Keyed & {
	slug: string;
	name: string;
	description: string | null;
	status: ProjectStatus;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
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
};

export type MediaKind = 'image' | 'video';
export type MediaStatus = 'pending' | 'ready' | 'failed';

export type Media = Keyed & {
	agentId: string;
	/** Null until an update references it: upload precedes the post (design §3). */
	updateId: string | null;
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
};

export type Message = Keyed & {
	projectId: string | null;
	updateId: string | null;
	taskId: string | null;
	/** Either the literal `human` or `agent:<agent_id>` (design §3). */
	author: string;
	body: string;
	createdAt: number;
};

export type ReadCursor = Keyed & {
	agentId: string;
	lastSeenMessageSeq: number;
};

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'timeout' | 'cancelled';

export type Approval = Keyed & {
	agentId: string;
	projectId: string | null;
	updateId: string | null;
	question: string;
	/** The buttons the owner is offered, if the agent supplied any. */
	options: string[] | null;
	state: ApprovalState;
	expiresAt: number;
	decidedAt: number | null;
	decidedValue: string | null;
};
