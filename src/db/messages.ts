/**
 * `messages` (design §3).
 *
 * A message can hang off a project, an update or a task, or none of them.
 * `author` is the literal `human` or `agent:<agent_id>` — this layer stores the
 * string and does not interpret it.
 *
 * Everything here reads oldest first: a message list is a conversation being
 * caught up on, not a timeline being scrolled back through.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Message } from './types';

type Row = {
	seq: number;
	id: string;
	project_id: string | null;
	update_id: string | null;
	task_id: string | null;
	author: string;
	body: string;
	created_at: number;
	reply_to: string | null;
	deleted_at: number | null;
	answers: string | null;
	request_id: string | null;
	edited_at: number | null;
	pinned: number;
	status: string | null;
	status_at: number | null;
};

const COLUMNS = `seq, id, project_id, update_id, task_id, author, body, created_at, reply_to, deleted_at, answers, request_id,
	edited_at, pinned, status, status_at`;

/**
 * The rule every read here keeps: a deleted message is gone.
 *
 * Written once, as a fragment, rather than remembered at each call site — a
 * query that forgot it would put an unsent line back in somebody's thread, and
 * that is exactly the kind of omission nobody notices until it is on screen.
 */
const LIVE = `deleted_at IS NULL`;

function toMessage(row: Row): Message {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		updateId: row.update_id,
		taskId: row.task_id,
		author: row.author,
		body: row.body,
		createdAt: row.created_at,
		replyTo: row.reply_to,
		deletedAt: row.deleted_at,
		answers: row.answers,
		requestId: row.request_id,
		editedAt: row.edited_at,
		pinned: row.pinned === 1,
		status: row.status as Message['status'],
		statusAt: row.status_at
	};
}

export type NewMessage = {
	id?: string;
	projectId?: string | null;
	updateId?: string | null;
	taskId?: string | null;
	/** `human`, or `agent:<agent_id>`. */
	author: string;
	body: string;
	createdAt?: number;
	/** The message this answers (migration 014). */
	replyTo?: string | null;
	/** The comment in the same thread this one is addressed to (migration 020). */
	answers?: string | null;
	/** The request being talked over before it is answered (migration 032). */
	requestId?: string | null;
};

export function insertMessage(db: Db, input: NewMessage): Message {
	const row = {
		id: input.id ?? newId(),
		project_id: orNull(input.projectId),
		update_id: orNull(input.updateId),
		task_id: orNull(input.taskId),
		author: input.author,
		body: input.body,
		created_at: input.createdAt ?? Date.now(),
		reply_to: orNull(input.replyTo),
		answers: orNull(input.answers),
		request_id: orNull(input.requestId)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO messages
			   (id, project_id, update_id, task_id, author, body, created_at, reply_to, answers, request_id)
			 VALUES (:id, :project_id, :update_id, :task_id, :author, :body, :created_at, :reply_to, :answers,
			         :request_id)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toMessage(inserted);
}

/**
 * An author's own correction (migration 033).
 *
 * Only a live message: an unsent line cannot be rewritten back into existence,
 * and `RETURNING` with the same `deleted_at IS NULL` guard `editUpdate` uses is
 * what makes that one statement rather than a read and a race.
 *
 * Whose message it is, and whether they may, is `$domain`'s to decide — this
 * layer writes rows.
 */
export function editMessage(
	db: Db,
	id: string,
	edit: { body: string; editedAt: number }
): Message | undefined {
	const row = db
		.prepare<{ id: string; body: string; edited_at: number }, Row>(
			`UPDATE messages SET body = :body, edited_at = :edited_at
			 WHERE id = :id AND ${LIVE}
			 RETURNING ${COLUMNS}`
		)
		.get({ id, body: edit.body, edited_at: edit.editedAt });

	return row && toMessage(row);
}

/**
 * One message, deleted or not.
 *
 * Unfiltered on purpose, unlike every list here: a caller that has an id is
 * asking about that row, and deleting something twice has to be answerable
 * without a second query. Callers that must not act on a deleted message check
 * `deletedAt`, which is the same shape `findUpdateById` keeps.
 */
export function findMessageById(db: Db, id: string): Message | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id);
	return row && toMessage(row);
}

/**
 * Soft delete.
 *
 * @returns whether this call was the one that deleted it, so only the first
 *   caller publishes `message.deleted`.
 */
export function softDeleteMessage(db: Db, id: string, at: number = Date.now()): boolean {
	return (
		db
			.prepare<[number, string]>(`UPDATE messages SET deleted_at = ? WHERE id = ? AND ${LIVE}`)
			.run(at, id).changes > 0
	);
}

/**
 * The live replies under one message.
 *
 * Deleting a post takes its replies with it — a thread hanging under a line
 * nobody can read is not a conversation — so the caller needs to know what they
 * are.
 */
export function listRepliesTo(db: Db, messageId: string): Message[] {
	return db
		.prepare<[string], Row>(
			`SELECT ${COLUMNS} FROM messages WHERE reply_to = ? AND ${LIVE} ORDER BY seq ASC`
		)
		.all(messageId)
		.map(toMessage);
}

export type MessageQuery = {
	projectId?: string;
	/**
	 * Any of these projects, for a reader scoped to a subscription.
	 *
	 * Separate from `projectId` because it has to be applied **in the query**: a
	 * caller that took a page and then filtered it in memory would get an empty
	 * page whenever the first N unread happened to be somewhere else, which is
	 * exactly how the channel went silent (see `unreadMessagesInScope`).
	 *
	 * An empty list matches nothing, never everything — "these projects" with
	 * none named is none.
	 */
	projectIds?: readonly string[];
	updateId?: string;
	taskId?: string;
	/** One request's discussion (migration 032). */
	requestId?: string;
	/** Everything newer than this seq: the read cursor's companion. */
	afterSeq?: number;
	/** Ignore messages by this author, typically the reader's own. */
	excludeAuthor?: string;
	/** Default 100. */
	limit?: number;
	/**
	 * Take the *newest* rows rather than the oldest.
	 *
	 * Reading a conversation means oldest first, which is why that is the
	 * default. Announcing one does not: a notification is about what just
	 * arrived, and taking the oldest of a long unread list means the newest
	 * message never reaches the window at all — which is exactly how new
	 * messages stopped being announced while five old ones were repeated.
	 *
	 * The rows still come back oldest first; only which ones are chosen changes.
	 */
	newest?: boolean;
	/**
	 * The agent reading, so a message that names other agents is left out
	 * (migration 044). Omitted, every message is in: the owner reads them all.
	 */
	reader?: string;
	/** Let a message naming the reader through whatever `projectIds` says. */
	mentionsAnywhere?: boolean;
};

/** Messages oldest first. */
export function listMessages(db: Db, query: MessageQuery = {}): Message[] {
	// An empty subscription matches nothing rather than everything.
	if (query.projectIds?.length === 0 && !query.mentionsAnywhere) return [];

	const params: Record<string, unknown> = {
		project_id: orNull(query.projectId),
		update_id: orNull(query.updateId),
		task_id: orNull(query.taskId),
		request_id: orNull(query.requestId),
		after_seq: orNull(query.afterSeq),
		exclude_author: orNull(query.excludeAuthor),
		limit: query.limit ?? 100
	};
	const scope = readerScope(query, params);

	const rows = db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM messages AS m
			 WHERE (:project_id IS NULL OR project_id = :project_id)
			   AND (:update_id IS NULL OR update_id = :update_id)
			   AND (:task_id IS NULL OR task_id = :task_id)
			   AND (:request_id IS NULL OR request_id = :request_id)
			   AND (:after_seq IS NULL OR seq > :after_seq)
			   AND (:exclude_author IS NULL OR author <> :exclude_author)
			   AND ${LIVE}${scope}
			 ORDER BY seq ${query.newest ? 'DESC' : 'ASC'}
			 LIMIT :limit`
		)
		.all(params)
		.map(toMessage);

	// Chosen newest-first, read oldest-first: a caller wanting the latest few
	// still wants them in the order they were said.
	return query.newest ? rows.reverse() : rows;
}

/**
 * How many messages sit after a cursor: the unread count the heartbeat carries
 * back to an agent (design §5).
 */
export function countMessagesAfter(
	db: Db,
	afterSeq: number,
	query: { projectId?: string; projectIds?: readonly string[]; excludeAuthor?: string } = {}
): number {
	const params: Record<string, unknown> = {
		after_seq: afterSeq,
		project_id: orNull(query.projectId),
		exclude_author: orNull(query.excludeAuthor)
	};

	// An explicit list of projects, for a caller that wants "anything in the
	// places this agent works" rather than one project or all of them. Expanded
	// into placeholders because SQLite has no array parameter; an empty list is
	// not the same as an absent one and is answered without a query at all,
	// since `IN ()` is a syntax error and would otherwise mean "match nothing"
	// written as a crash.
	let scope = '';
	if (query.projectIds) {
		if (query.projectIds.length === 0) return 0;
		scope = ` AND project_id IN (${query.projectIds.map((_, index) => `:p${index}`).join(', ')})`;
		query.projectIds.forEach((id, index) => (params[`p${index}`] = id));
	}

	return db
		.prepare<typeof params, { n: number }>(
			`SELECT count(*) AS n FROM messages
			 WHERE seq > :after_seq
			   AND ${LIVE}
			   AND (:project_id IS NULL OR project_id = :project_id)
			   AND (:exclude_author IS NULL OR author <> :exclude_author)${scope}`
		)
		.get(params)!.n;
}

/**
 * What one agent has not read, with a cursor per project (migration 025).
 *
 * The comparison is per row: a message is unread when its seq is past *its own
 * project's* cursor for this reader. Done as a join rather than by asking for
 * each project in turn, because the answer has to be one ordered page — a
 * caller announcing the newest few cannot assemble them from several lists
 * without re-sorting and re-limiting what it just fetched.
 *
 * A message belonging to no project is compared against the `''` bucket, which
 * is why the cursor column is empty-string-defaulted rather than nullable.
 */
export type UnreadQuery = {
	agentId: string;
	/** Only these projects. An empty list matches nothing, never everything. */
	projectIds?: readonly string[];
	/** Ignore messages by this author, typically the reader's own. */
	excludeAuthor?: string;
	/** Default 100. */
	limit?: number;
	/** Take the newest rather than the oldest; see {@link MessageQuery}. */
	newest?: boolean;
	/** Let a message naming this agent through whatever `projectIds` says. */
	mentionsAnywhere?: boolean;
	/** Only messages filed under this one project, `NO_PROJECT` for none. */
	within?: string;
};

/** The join every unread question shares: this reader's cursor for each row. */
const UNREAD = `
	FROM messages AS m
	LEFT JOIN read_cursors AS rc
	  ON rc.agent_id = :agent_id AND rc.project_id = coalesce(m.project_id, '')
	 WHERE m.seq > coalesce(rc.last_seen_message_seq, 0)
	   AND m.${LIVE}
	   AND (:exclude_author IS NULL OR m.author <> :exclude_author)`;

/** Unread messages, oldest first. */
export function listUnreadMessages(db: Db, query: UnreadQuery): Message[] {
	if (query.projectIds?.length === 0 && !query.mentionsAnywhere) return [];

	const params: Record<string, unknown> = {
		agent_id: query.agentId,
		exclude_author: orNull(query.excludeAuthor),
		limit: query.limit ?? 100
	};
	const scope = unreadScope(query, params);

	const rows = db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS.split(', ')
				.map((column) => `m.${column}`)
				.join(', ')}${UNREAD}${scope}
			 ORDER BY m.seq ${query.newest ? 'DESC' : 'ASC'}
			 LIMIT :limit`
		)
		.all(params)
		.map(toMessage);

	return query.newest ? rows.reverse() : rows;
}

/** How many messages this reader has not read: the heartbeat's number. */
export function countUnreadMessages(db: Db, query: Omit<UnreadQuery, 'limit' | 'newest'>): number {
	if (query.projectIds?.length === 0 && !query.mentionsAnywhere) return 0;

	const params: Record<string, unknown> = {
		agent_id: query.agentId,
		exclude_author: orNull(query.excludeAuthor)
	};
	const scope = unreadScope(query, params);

	return db
		.prepare<typeof params, { n: number }>(`SELECT count(*) AS n${UNREAD}${scope}`)
		.get(params)!.n;
}

/** The unread reader's scope, plus the one-project filter only unread reads take. */
function unreadScope(
	query: Omit<UnreadQuery, 'limit' | 'newest'>,
	params: Record<string, unknown>
): string {
	const scope = readerScope({ ...query, reader: query.agentId }, params);
	if (query.within === undefined) return scope;
	params.within = query.within;
	return `${scope} AND coalesce(m.project_id, '') = :within`;
}

/**
 * Who a message reaches (migration 044), as SQL to append to a query on `m`.
 *
 * A message that names agents with `@name` reaches only those agents, wherever
 * they usually work when `mentionsAnywhere` is set. A message that names nobody
 * reaches whoever the project scope says, exactly as before mentions existed.
 * No reader means the owner, who sees everything.
 */
function readerScope(
	query: { projectIds?: readonly string[]; reader?: string; mentionsAnywhere?: boolean },
	params: Record<string, unknown>
): string {
	let inProjects = '';
	if (query.projectIds) {
		query.projectIds.forEach((id, index) => (params[`p${index}`] = id));
		inProjects =
			query.projectIds.length === 0
				? '0'
				: `m.project_id IN (${query.projectIds.map((_, index) => `:p${index}`).join(', ')})`;
	}
	if (query.reader === undefined) return inProjects ? ` AND ${inProjects}` : '';

	params.reader = query.reader;
	const namesAnyone = `EXISTS (SELECT 1 FROM message_mentions AS mm WHERE mm.message_id = m.id)`;
	const namesReader = `EXISTS (SELECT 1 FROM message_mentions AS mm
	                             WHERE mm.message_id = m.id AND mm.agent_id = :reader)`;
	const audience = ` AND (NOT ${namesAnyone} OR ${namesReader})`;
	if (!inProjects) return audience;
	return query.mentionsAnywhere
		? `${audience} AND (${inProjects} OR ${namesReader})`
		: `${audience} AND ${inProjects}`;
}

/**
 * Every project one agent has anything to do with.
 *
 * There is no "assignment" in this product — an agent is not a member of a
 * project, it just works in one — so relevance is derived from what it has
 * actually done: posted an update, been handed a task, or spoken in a thread.
 * That is the honest answer to "should this agent be woken for this project",
 * and it needs no configuration anybody could forget to set.
 *
 * An empty list means an agent that has done nothing yet, which callers treat
 * as "hears everything" rather than "hears nothing": a brand new agent must not
 * be deaf to the first message ever sent to it.
 */
export function listAgentProjectIds(db: Db, agentId: string, author: string): string[] {
	const params = { agent_id: agentId, author };
	return db
		.prepare<typeof params, { project_id: string }>(
			`SELECT DISTINCT project_id FROM updates WHERE agent_id = :agent_id
			 UNION
			 SELECT DISTINCT project_id FROM tasks
			  WHERE agent_id = :agent_id AND project_id IS NOT NULL
			 UNION
			 SELECT DISTINCT project_id FROM messages
			  WHERE author = :author AND project_id IS NOT NULL AND ${LIVE}`
		)
		.all(params)
		.map((row) => row.project_id);
}
