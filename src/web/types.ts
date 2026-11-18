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
export type UpdatePriority = 'low' | 'medium' | 'high' | 'critical';

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
/**
 * What an attachment is for.
 *
 * `image`, `video` and `audio` are rendered on the card; `file` is anything else
 * — a PDF, a log, a zip — which is listed with its name and downloaded, never
 * rendered (migrations 026, 038).
 */
/**
 * A word a project decided for itself (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 */
export type TagView = {
	id: string;
	projectId: string;
	name: string;
	slug: string;
	/** A palette name — see `tags.ts` — or `null` for the default grey. */
	colour: string | null;
	/** The agent that decided it, or `null` for the owner. */
	agentId: string | null;
	createdAt: number;
};

/** One of those words, on one card. */
export type CardTagView = {
	id: string;
	tagId: string;
	card: { kind: string; id: string };
	/** Who put it there: `human`, or `agent:<agent_id>`. */
	author: string;
	createdAt: number;
};

/**
 * A note pinned to a card (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like, they are hidden by default, but can be viewed on
 * the dashboard, and updated by the user and agent alike."
 */
export type CardFieldView = {
	id: string;
	card: { kind: string; id: string };
	name: string;
	slug: string;
	value: string;
	/** Who set it last: `human`, or `agent:<agent_id>`. */
	author: string;
	createdAt: number;
	updatedAt: number;
};

/**
 * One showing of an app on a card (migration 041).
 *
 * The shape `$domain/apps.ts` returns, named here rather than imported for the
 * reason every other view type is: `$web` may not reach past the wire.
 */
export type AppView = {
	id: string;
	card: { kind: string; id: string };
	/** The app's `ui://` handle. */
	uri: string;
	name: string;
	description: string | null;
	/**
	 * The page this app frames, or `null` for a document the dashboard serves
	 * (migration 042). A service's own page runs on its own origin; a document
	 * the dashboard serves runs on none.
	 */
	url: string | null;
	title: string | null;
	/** What the agent handed it. */
	data: Record<string, unknown>;
	/** What the app saved for itself, or `null` if it never has. */
	state: Record<string, unknown> | null;
	author: string;
	agentId: string | null;
	createdAt: number;
	updatedAt: number;
};

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

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
	/** Which card it is on: exactly one of the four (migration 030). */
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	taskId: string | null;
	kind: MediaKind;
	mime: string;
	status: MediaStatus;
	/** How big it is, so a download can say so before it is fetched. */
	bytes: number;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	/**
	 * What it was called when it was uploaded, for a `file`.
	 *
	 * `null` for a picture, which is its own label. It is the only thing a
	 * download tile has to show, so it travels with the row.
	 */
	filename: string | null;
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
	share?: { views: number; sharedAt: number };
	/**
	 * The emoji on the card itself (migration 034).
	 *
	 * Optional on the same terms as `media`: it rides with every real response,
	 * and a spec that builds a card from three fields should not have to say
	 * "nobody reacted" to do so.
	 */
	reactions?: ReactionView[];
	/**
	 * Where the work on this card has got to (migration 035).
	 *
	 * `null` or absent for an ordinary card, which is most of them. Marking one
	 * is what the task board used to be.
	 */
	status?: string | null;
	/** When that state last changed, which moves the card up the feed (037). */
	statusAt?: number | null;
	/**
	 * The media grid's contents, in upload order (design §7).
	 *
	 * Optional only because a card is renderable without it — a spec builds one
	 * from three fields, and an update posted before this field existed is a
	 * plain-text card either way. Every real response carries an array, empty
	 * included.
	 */
	media?: MediaView[];
	/**
	 * The embeds on this card (migration 027).
	 *
	 * Optional on the same terms as `media`: a spec that builds a card from three
	 * fields should not have to say "no embeds" to do so.
	 */
	embeds?: EmbedView[];
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
	/** Picture questions: the media id of the image on an option, by option. */
	optionMedia?: Record<string, string>;
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
	/**
	 * The thread it was asked in (migration 022).
	 *
	 * A question raised inside a conversation renders there, under the words that
	 * led to it, rather than as a card of its own with none of the context beside
	 * it.
	 */
	messageId?: string | null;
	kind: RequestKind;
	question: string;
	detail: string | null;
	options: string[] | null;
	config: RequestConfig | null;
	state: RequestState;
	expiresAt: number;
	answeredAt: number | null;
	answer: RequestAnswer | null;
	/**
	 * What the card carries, on the same terms as an update's (migration 030).
	 *
	 * "Does this look right" is a question you cannot ask without the thing being
	 * looked at. Optional so a spec that builds a request from its five real
	 * fields does not have to say "nothing attached" to do so.
	 */
	media?: MediaView[];
	embeds?: EmbedView[];
	/** When the asking agent last rewrote the question (migration 033). */
	editedAt?: number | null;
	/** Kept at the top of the feed by the owner (migration 034). */
	pinned?: boolean;
	/** The emoji on the question itself (migration 034). */
	reactions?: ReactionView[];
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
	embeds: EmbedView[];
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
	/** The words the projects in this snapshot use (migration 039). */
	tags?: TagView[];
	/** Where those words are worn, across every card in this snapshot. */
	cardTags?: CardTagView[];
	/** What is noted on the cards in this snapshot (migration 040). */
	cardFields?: CardFieldView[];
	/** The apps showing on the cards in this snapshot (migration 041). */
	cardApps?: AppView[];
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
	/** The images on them, keyed by message id (migration 016). */
	messageMedia?: Record<string, MediaView[]>;
	/** The embeds on them, keyed by message id (migration 027). */
	messageEmbeds?: Record<string, EmbedView[]>;
};

/**
 * What an agent is saying about a message or a task, without words
 * (migration 013).
 *
 * `thinking` is a claim about *now*, so the dashboard renders it only while
 * that agent is online; `read` and `done` are facts about the past and stay
 * whatever happened to the agent afterwards.
 */
export type AckState = 'thinking' | 'read' | 'done';

export type AckView = {
	id: string;
	seq: number;
	agentId: string;
	/** The card it is on — any of the four, since migration 034. */
	card: { kind: string; id: string };
	/** The same fact by the older names, for the two kinds that had them first. */
	messageId: string | null;
	taskId: string | null;
	state: AckState;
	/** When the agent first said anything about this thing. */
	createdAt: number;
	/** When it last changed what it was saying. */
	updatedAt: number;
};

/**
 * One message handed to one agent (migration 018).
 *
 * The state between "unread" and "acknowledged". An agent that has been handed
 * something and said nothing is a different situation from an agent that was
 * never told, and until this existed the dashboard showed both the same way.
 */
export type DeliveryView = {
	id: string;
	seq: number;
	messageId: string;
	agentId: string;
	deliveredAt: number;
};

/** Where a task is in its life (design §3). */
export type TaskState = 'todo' | 'claimed' | 'done' | 'cancelled';

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
	/**
	 * The comment in the same thread this one answers (migration 020).
	 *
	 * A label rather than a structure: the message sits in the same flat thread,
	 * and the card shows who it was addressed to. That is what keeps a card
	 * carrying two conversations readable without nesting anything.
	 */
	answers?: string | null;
	/**
	 * The request whose discussion this belongs to (migration 032).
	 *
	 * A question can be talked over before it is answered, and those lines live
	 * on the request rather than in the feed: a message with a `requestId` is not
	 * a post, and renders under the question it is about.
	 */
	requestId?: string | null;
	author: string;
	body: string;
	createdAt: number;
	/**
	 * Kept at the top of the feed by the owner (migration 034).
	 *
	 * The owner: "let me pin my own messages." A post is a card, and every card
	 * can be pinned — it was an update's alone only because updates were the only
	 * cards when the pin was written.
	 */
	pinned?: boolean;
	/** Where the work on this post has got to (migration 035). */
	status?: string | null;
	/** When that state last changed, which moves the card up the feed (037). */
	statusAt?: number | null;
	/**
	 * When its author last corrected it (migration 033).
	 *
	 * Rendered, never silent: a reader who saw the line earlier has to be able to
	 * tell that what it says now is not what it said then.
	 */
	editedAt?: number | null;
};

/** `GET /api/messages`: every thread in scope, stamped with the cursor it is good to. */
/** One notification as the bell renders it (migration 021). */
export type NotificationView = {
	id: string;
	seq: number;
	kind: 'update' | 'reply' | 'request';
	projectId: string | null;
	projectSlug: string | null;
	projectName: string | null;
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	agentId: string | null;
	title: string;
	body: string;
	createdAt: number;
	seenAt: number | null;
	/** Where clicking it goes: a route, plus the thing to focus once there. */
	path: string;
};

/** One emoji reaction on a message (migration 024). */
export type ReactionView = {
	id: string;
	seq: number;
	/** The card it is on — any of the four, since migration 034. */
	card: { kind: string; id: string };
	/** The message, when it is one; `null` on any other kind of card. */
	messageId: string | null;
	/** The literal `human` for the owner, or `agent:<agent_id>` (design §3). */
	actor: string;
	emoji: string;
	createdAt: number;
};

/** What `GET /api/notifications` sends. */
export type NotificationsSnapshot = {
	seq: number;
	at: string;
	notifications: NotificationView[];
	/** How many have not been looked at: the number on the bell. */
	unseen: number;
};

export type MessagesSnapshot = {
	/** The newest event seq this state accounts for. */
	seq: number;
	at: string;
	/** Oldest first: a conversation is read downwards. */
	messages: MessageView[];
	/** The acknowledgements on those messages (migration 013). */
	acks?: AckView[];
	/** The images on them, keyed by message id (migration 016). */
	media?: Record<string, MediaView[]>;
	/** The embeds on them, keyed by message id (migration 027). */
	embeds?: Record<string, EmbedView[]>;
	/** Who each message has actually reached (migration 018). */
	deliveries?: DeliveryView[];
	/** The emoji reactions on them (migration 024). */
	reactions?: ReactionView[];
};

/**
 * Embeds: something shown in the style of where it came from (migration 027).
 *
 * The shapes here mirror `$domain/embeds.ts` rather than importing them, as
 * every view type in this file does: `$web` talks to the HTTP API and to
 * nothing below it (design §2).
 *
 * The important thing to know while reading the renderer is that **none of this
 * is markup**. A spec names blocks from a closed list and colours that are hex
 * literals, both checked on the server before the row exists, and every value in
 * it is drawn as text. There is nothing here to sanitise because there is
 * nothing here that could become HTML.
 */
export type EmbedFont = 'sans' | 'serif' | 'mono';
export type EmbedRadius = 'none' | 'sm' | 'md' | 'lg';

/**
 * The layout knobs (migration 028).
 *
 * A palette alone cannot make a card look like where it came from: a Slack
 * message is a rounded-square avatar with the name and time on one line, and a
 * GitHub comment is a circular avatar in a tinted bar above a white body. These
 * say which, and every one is a closed list the renderer turns into a class it
 * wrote itself.
 */
export type EmbedAvatarShape = 'circle' | 'rounded' | 'square';
export type EmbedSize = 'sm' | 'md' | 'lg';
export type EmbedHeaderLayout = 'inline' | 'stacked';
export type EmbedTone = 'normal' | 'muted' | 'accent';
export type EmbedChipStyle = 'pill' | 'lozenge' | 'tag';
export type EmbedFieldLayout = 'rows' | 'inline';
export type EmbedPadding = 'tight' | 'normal' | 'roomy';

/**
 * The brand marks the client can draw (migration 029).
 *
 * Inline SVG owned by `EmbedMark.svelte`, so a mark never fetches anything and a
 * look carries only a name.
 */
export type EmbedMark =
	'slack' | 'github' | 'gitlab' | 'jira' | 'confluence' | 'linear' | 'notion' | 'figma' | 'link';

/** The card itself, rather than what is in it. */
export type EmbedFrame = {
	/** Draw the outer border. `true` unless a look says otherwise. */
	border?: boolean;
	/** The accent bar down the left edge. Off unless a look asks. */
	stripe?: boolean;
	padding?: EmbedPadding;
	/** Line the body up under the header's words rather than under its avatar. */
	indent?: boolean;
};

/** The palette one look is drawn in. Every colour is `#rrggbb`. */
export type EmbedTheme = {
	accent?: string;
	background?: string;
	foreground?: string;
	muted?: string;
	border?: string;
	font?: EmbedFont;
	radius?: EmbedRadius;
};

/** The badge along the top: where this came from. */
export type EmbedChrome = {
	label?: string;
	icon?: string;
	/** The source's own brand mark, drawn in the card's top corner. */
	mark?: EmbedMark;
	/** A mark for a source we ship none for: a media id or an https image URL. */
	image?: string;
};

/** One drawable piece. The `type` is the whole of what decides how it renders. */
export type EmbedBlock =
	| {
			type: 'header';
			avatar?: string;
			title?: string;
			subtitle?: string;
			meta?: string;
			shape?: EmbedAvatarShape;
			size?: EmbedSize;
			layout?: EmbedHeaderLayout;
			bar?: boolean;
	  }
	| { type: 'heading'; value: string; level?: 1 | 2 }
	| { type: 'text'; value: string; tone?: EmbedTone; size?: EmbedSize }
	| { type: 'markdown'; value: string; size?: EmbedSize }
	| { type: 'code'; value: string; language?: string }
	| { type: 'quote'; value: string }
	| { type: 'fields'; items: { label: string; value: string }[]; layout?: EmbedFieldLayout }
	| { type: 'chips'; value: string; style?: EmbedChipStyle }
	| { type: 'image'; value: string; alt?: string }
	| { type: 'divider' }
	| { type: 'footer'; value?: string; url?: string };

export type EmbedSpec = {
	theme: EmbedTheme;
	chrome: EmbedChrome;
	frame: EmbedFrame;
	blocks: EmbedBlock[];
};

/** The values one embed shows. A string, or a list of them for chips. */
export type EmbedData = Record<string, string | string[]>;

/** One embed as a card renders it: the values, and the look to draw them in. */
export type EmbedView = {
	id: string;
	/** Which card it is on: exactly one of the four (migration 030). */
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	taskId: string | null;
	/** The look's slug, for a `data-` attribute a test can find it by. */
	type: string;
	typeName: string;
	spec: EmbedSpec;
	data: EmbedData;
	/** Where it was copied from, if the poster said. Always http or https. */
	sourceUrl: string | null;
	createdAt: number;
};
