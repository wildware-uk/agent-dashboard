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
import type { CardRef, CardStatus } from './cards';

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
export type UpdatePriority = 'low' | 'medium' | 'high' | 'critical';

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
	/**
	 * The task this was progress on. Dead since migration 035 took the board
	 * away; the old values are kept as the history of what was filed where.
	 */
	taskId: string | null;
	/**
	 * Where the work on this card has got to (migration 035).
	 *
	 * `null` for an ordinary card. Marking one is what the task board used to be.
	 */
	status: CardStatus | null;
	/**
	 * When that state last changed (migration 037).
	 *
	 * What brings a card that moved back to the top of the feed. `null` for one
	 * nobody has marked since the column existed.
	 */
	statusAt: number | null;
};

/**
 * What an attachment is for (migrations 026, 038).
 *
 * `image`, `video` and `audio` are rendered on the page; `file` is anything else
 * — stored, listed and downloaded, never served inline.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'file';
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
	/**
	 * The approval this is on, or the task, when it is on one of those
	 * (migration 030).
	 *
	 * Four anchors and exactly one of them set. The owner asked for every card
	 * type to carry the same things, and this is that sentence in the schema:
	 * there was never a reason an approval could not hold a screenshot, only an
	 * order in which the features happened to land.
	 */
	requestId: string | null;
	taskId: string | null;
	kind: MediaKind;
	mime: string;
	bytes: number;
	sha256: string;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	/**
	 * What the uploader called it, for a `file` (migration 026).
	 *
	 * `null` for images and video, where the picture is its own label and the name
	 * was genuinely never kept. Text: it names nothing on this filesystem.
	 */
	filename: string | null;
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
	/** The card it is on — any of the four, since migration 034. */
	card: CardRef;
	/** Exactly one of these four is set; `card` is the same fact, named once. */
	messageId: string | null;
	taskId: string | null;
	updateId: string | null;
	requestId: string | null;
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
	/** Kept at the top of its column by the owner (migration 034). */
	pinned: boolean;
	/** When its words were last corrected (migration 034). */
	editedAt: number | null;
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
	/**
	 * The comment in the same thread this one answers (migration 020).
	 *
	 * Display, not structure: which thread a message is in is still `updateId`,
	 * `taskId` or `replyTo`. This says who it was addressed to, so a thread with
	 * two conversations running through it can be read.
	 */
	answers: string | null;
	/**
	 * The request whose discussion this belongs to (migration 032).
	 *
	 * A thread on a question the owner has not answered yet: "why do you want to
	 * do that?" before the button is pressed. Its own anchor because a request
	 * often hangs off no card at all.
	 */
	requestId: string | null;
	/**
	 * When the author last corrected it, or `null` if nobody has (migration 033).
	 *
	 * Stated rather than silent, exactly as `updates.editedAt` is: a reader who
	 * saw the line earlier has to be able to tell it has changed.
	 */
	editedAt: number | null;
	/** Kept at the top of the feed by the owner (migration 034). */
	pinned: boolean;
	/**
	 * Where the work on this card has got to (migration 035).
	 *
	 * `null` for an ordinary card. Marking one is what the task board used to be.
	 */
	status: CardStatus | null;
	/**
	 * When that state last changed (migration 037).
	 *
	 * What brings a card that moved back to the top of the feed. `null` for one
	 * nobody has marked since the column existed.
	 */
	statusAt: number | null;
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

/** What kind of thing a notification points at (migration 021). */
export type NotificationKind = 'update' | 'reply' | 'request';

/**
 * One thing the owner was told about, kept so the app can show it (migration 021).
 *
 * The columns are the *target* rather than the sentence: what an owner wants
 * from a notification an hour later is not the words, it is the card it came
 * from. Exactly one of `updateId`, `messageId` and `requestId` is set.
 */
export type Notification = Keyed & {
	kind: NotificationKind;
	projectId: string | null;
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	/** Who caused it, for the avatar beside it. */
	agentId: string | null;
	title: string;
	body: string;
	createdAt: number;
	/** When the owner looked at it. Server-side, so a phone and a desk agree. */
	seenAt: number | null;
};

/**
 * One emoji reaction on one message (migration 024).
 *
 * `actor` is the literal `human` or `agent:<agent_id>`, the same string
 * `messages.author` uses: the owner is not a row (design §1, §3).
 */
export type Reaction = Keyed & {
	/** The card it is on — any of the four, since migration 034. */
	card: CardRef;
	/**
	 * The message it is on, or `null` for a reaction on another kind of card.
	 *
	 * Kept beside `card` because a thread is where most reactions live and the
	 * readers that render one ask this question and no other.
	 */
	messageId: string | null;
	actor: string;
	emoji: string;
	createdAt: number;
};

export type ReadCursor = Keyed & {
	agentId: string;
	/** The project this cursor is for; `''` for messages that belong to none. */
	projectId: string;
	lastSeenMessageSeq: number;
};

/**
 * How a request ended, as the row stores it.
 *
 * `cancelled` is the owner declining to answer; `withdrawn` is the asking agent
 * taking the question back because it stopped mattering (migration 031). Two
 * different facts about who ended it and why, worth telling apart in history.
 */
export type ApprovalState =
	'pending' | 'approved' | 'rejected' | 'timeout' | 'cancelled' | 'withdrawn';

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
	/**
	 * Picture questions: the image shown on an option, by option. Each id is one
	 * of the request's own media, attached with it.
	 */
	optionMedia?: Record<string, string>;
};

export type Approval = Keyed & {
	agentId: string;
	projectId: string | null;
	updateId: string | null;
	/**
	 * The thread this was asked in (migration 022).
	 *
	 * An agent talking to the owner in a thread and then needing a decision used
	 * to have to ask somewhere else entirely. This is where the question renders,
	 * and it changes nothing else about the row.
	 */
	messageId: string | null;
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
	/**
	 * When the asking agent last corrected the question (migration 033).
	 *
	 * `null` for one nobody has touched, and shown on the card either way: an
	 * owner half way through deciding has to be able to tell that the question
	 * moved under them.
	 */
	editedAt: number | null;
	/** Kept at the top of the feed by the owner (migration 034). */
	pinned: boolean;
	/** How much it needs the owner now (migration 048). */
	priority: UpdatePriority;
};

/**
 * One registered look (migration 027).
 *
 * `spec` is JSON text and stays that way through this layer: what a legal spec
 * is belongs with the renderer's answer to the same question, in
 * `$domain/embeds.ts`.
 */
export type EmbedType = Keyed & {
	/** What an agent names to use it. Stable, lowercase, unique. */
	slug: string;
	name: string;
	/** Who registered it, or `null` for one this deployment ships. */
	agentId: string | null;
	/** The blocks and palette, as JSON text. Never markup. */
	spec: string;
	createdAt: number;
	updatedAt: number;
};

/** One thing being shown in a registered look (migration 027). */
export type Embed = Keyed & {
	typeId: string;
	/**
	 * Which card this is on: exactly one of the four is set (migration 030).
	 *
	 * An update, a message, an approval or a task — every card type carries the
	 * same things, which is what the owner asked for and what there was never a
	 * reason not to have.
	 */
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	taskId: string | null;
	agentId: string | null;
	/** `human` or `agent:<agent_id>`, as messages use. */
	author: string;
	/** The values it shows, as a flat JSON object of strings. */
	data: string;
	/** Where it was copied from, if the poster said. */
	sourceUrl: string | null;
	createdAt: number;
};

/**
 * A word a project decided for itself (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc." Defined once, then offered as a button on every
 * card in that project.
 */
export type Tag = Keyed & {
	projectId: string;
	/** The word as it is written on a card. */
	name: string;
	/** The same word normalised, which is what "already defined" is judged on. */
	slug: string;
	/** A palette name ('rose', 'amber', …), or `null` for the default. */
	colour: string | null;
	/** The agent that defined it, or `null` for the owner. */
	agentId: string | null;
	createdAt: number;
};

/** One of a project's tags, on one card (migration 039). */
export type CardTag = Keyed & {
	tagId: string;
	/** The card it is on — any kind, the generic way (migration 034). */
	card: CardRef;
	/** Who put it there: the literal `human`, or `agent:<agent_id>`. */
	author: string;
	createdAt: number;
};

/**
 * A note pinned to a card (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like." One row per name per card, so two agents writing
 * different fields cannot lose each other's work, and each one records who set
 * it and when.
 */
export type CardField = Keyed & {
	/** The card it is on — any kind, the generic way (migration 034). */
	card: CardRef;
	/** What it is called, as it is shown. */
	name: string;
	/** The same, normalised: what "already set" is judged on. */
	slug: string;
	/** What it says. Text, always: this is a note, not a type system. */
	value: string;
	/** Who set it last: the literal `human`, or `agent:<agent_id>`. */
	author: string;
	createdAt: number;
	/** When it was last corrected, which is a different fact from when it began. */
	updatedAt: number;
};

/**
 * Interactive UI an agent supplies (migration 041).
 *
 * The owner: "I want apps to be able to embed UI directly into the dashboard."
 * Registered once by its `ui://` URI and shown as often as the agent likes, in
 * the shape MCP Apps (SEP-1865) gives it.
 */
export type App = Keyed & {
	/** The spec's own handle, e.g. `ui://review-board`. */
	uri: string;
	name: string;
	description: string | null;
	/** Who registered it, or `null` for one this deployment ships. */
	agentId: string | null;
	/** The document, served into a sandboxed frame and never into the page. */
	html: string;
	/**
	 * The page to frame instead, for an app that lives somewhere else (042).
	 *
	 * `null` for one this deployment serves. Exactly one of `html` and `url` is
	 * meaningful, which the domain enforces.
	 */
	url: string | null;
	/** The origins it declared, as JSON: `{ connect, resource, frame }`. */
	csp: string;
	createdAt: number;
	updatedAt: number;
};

/**
 * One showing of one app, on one card (migration 041).
 *
 * `data` is what the agent handed it; `state` is what the app itself has saved
 * since. Two directions, two columns: an agent re-sending its data must not
 * wipe out the half-filled form in front of the owner.
 */
export type AppView = Keyed & {
	appId: string;
	/** The card it is on — any kind, the generic way (migration 034). */
	card: CardRef;
	agentId: string | null;
	/** Who put it there: the literal `human`, or `agent:<agent_id>`. */
	author: string;
	/** What the agent sent it, as JSON text. */
	data: string;
	/** What the app saved for itself, as JSON text, or `null` if it never has. */
	state: string | null;
	/** A line above the frame, so a collapsed app still says what it is. */
	title: string | null;
	createdAt: number;
	updatedAt: number;
};
