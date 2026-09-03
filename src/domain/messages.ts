/**
 * Messages: the owner talking back to agents, and agents answering (design §3, §5).
 *
 * Two rules from §3 shape every function here.
 *
 * **`author` is a string, not a foreign key.** It is either the literal `human`
 * or `agent:<agent_id>`, because the owner is not a row: there is no user table
 * in a single-owner deployment (§1), so a nullable `agent_id` plus a flag would
 * be two columns encoding one fact. {@link authorText} and {@link parseAuthor}
 * are the only two places that format is written down.
 *
 * **Unread state lives in `read_cursors`, never as a flag on `messages`.** A
 * message is a row that happened; how far a given reader has got through them is
 * that reader's business. So "unread" is a comparison — `messages.seq` against
 * one integer per agent — and a second reader is a second row rather than a
 * schema change. That is also what makes {@link readMessages} safe to call twice
 * concurrently: the cursor only ever moves forward (`advanceReadCursor` takes a
 * `max`), so the slower of two overlapping reads cannot un-read the faster one's
 * messages.
 *
 * The one subtlety worth reading before changing anything: **a read only ever
 * advances the cursor over messages it actually handed over.** A read filtered
 * to one project, or resumed from an explicit `since`, would otherwise walk the
 * cursor past messages the agent has never seen — and since the heartbeat's
 * unread count is derived from that same cursor, they would be lost silently
 * rather than loudly. {@link readMessages} therefore stops the cursor at the
 * first unread message it did not return.
 *
 * The consequence is at-least-once delivery: a narrowed read can hand the same
 * message over twice, because the cursor is one position and may not pass what
 * the read stepped over. That is the right way round — an agent re-reading an
 * instruction costs a paragraph, an agent never seeing one is a silent failure.
 */
import {
	advanceReadCursor,
	attachMediaToMessage,
	countMessagesAfter,
	deliveredMessageIds,
	listDeliveries,
	recordDelivery,
	listAgentProjectIds,
	findAgentById,
	findMessageById,
	findTaskById,
	findUpdateById,
	insertMessage,
	listMessages,
	listRepliesTo,
	readCursorSeq,
	softDeleteMessage,
	type Message,
	type MessageDelivery
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { assertAttachableToMessage } from './media';
import { resolveProject } from './projects';
import { requiredText } from './text';

/**
 * Long enough for a real instruction with a snippet in it, short enough that a
 * thread stays readable on a phone. Two orders of magnitude under an update
 * body: a message is a remark, not a report.
 */
export const MESSAGE_BODY_MAX_LENGTH = 10_000;

/** How many messages one read hands over when the caller does not say. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** The most one read will ever hand over, however large a limit is asked for. */
export const MAX_MESSAGE_LIMIT = 200;

/** The owner. Not a row, so not an id (design §1, §3). */
export const HUMAN_AUTHOR = 'human';
/** What an agent's author string starts with. */
export const AGENT_AUTHOR_PREFIX = 'agent:';

/** Who wrote a message, before it is flattened into `messages.author`. */
export type MessageAuthor = { kind: 'human' } | { kind: 'agent'; agentId: string };

/** `human`, or `agent:<agent_id>` (design §3). */
export function authorText(author: MessageAuthor): string {
	return author.kind === 'human' ? HUMAN_AUTHOR : `${AGENT_AUTHOR_PREFIX}${author.agentId}`;
}

/**
 * Read an author string back.
 *
 * `null` for anything this module did not write, rather than a guess: a stored
 * author it cannot parse is a bug worth seeing, and inventing a human out of it
 * would attribute an agent's words to the owner.
 */
export function parseAuthor(author: string): MessageAuthor | null {
	if (author === HUMAN_AUTHOR) return { kind: 'human' };
	if (!author.startsWith(AGENT_AUTHOR_PREFIX)) return null;
	const agentId = author.slice(AGENT_AUTHOR_PREFIX.length);
	return agentId === '' ? null : { kind: 'agent', agentId };
}

export type PostMessageInput = {
	/**
	 * Who is writing. Adapters resolve an agent from its bearer token and the
	 * owner from the session cookie, never from a caller-supplied argument (§5).
	 */
	author: MessageAuthor;
	/** Markdown. Untrusted, and rendered with raw HTML disabled (design §8). */
	body: string;
	/** A project slug or id. Derived from the update or task when one is given. */
	project?: string | null;
	/** The update this is a reply on. */
	updateId?: string | null;
	/** The task this is about. */
	taskId?: string | null;
	/**
	 * The message this answers (migration 014).
	 *
	 * The owner's own feed posts anchor to nothing else — they are not about an
	 * update or a task, they *are* the thing being discussed — so a reply to one
	 * names the post directly. One level: a `replyTo` naming a message that is
	 * itself a reply is refused, because threads of threads are a shape nobody
	 * asked for and a renderer nobody wants to write.
	 */
	replyTo?: string | null;
	/**
	 * A comment in the same thread this message answers (migration 020).
	 *
	 * The owner asked to reply to a comment while keeping everything in one
	 * thread, and those two wishes pull against each other: a tree of replies is
	 * unreadable on a phone. So this is a *label*, not a structure. The message
	 * lands in the same flat thread as the one it answers — the anchor is taken
	 * from the target when the caller names no other — and the renderer shows who
	 * it was addressed to.
	 */
	answers?: string | null;
	/**
	 * Images to show on this message (migration 016).
	 *
	 * The owner's come from `POST /api/media`, an agent's from `create_upload`.
	 * All of them must be the caller's own and unattached, or the whole message
	 * is refused: a reply that silently dropped the screenshot it was about would
	 * be worse than one that failed to post.
	 */
	mediaIds?: readonly string[];
};

/**
 * Post one message and announce it.
 *
 * A message hangs off at most one thing — an update *or* a task — and its
 * project is derived from whichever that was, so the project a message belongs
 * to is never a second, disagreeing copy of the anchor's. Naming a project that
 * contradicts the anchor is refused rather than reconciled.
 *
 * @throws {DomainError} `not_found` for an unknown project, update, task or
 *   agent; `invalid_argument` for a blank body, two anchors, or an anchor from a
 *   different project than the one named.
 */
export function postMessage(ctx: DomainContext, input: PostMessageInput): Message {
	const body = requiredText(input.body, 'body', MESSAGE_BODY_MAX_LENGTH);
	const author = authorText(assertAuthor(ctx, input.author));

	// The comment being answered, resolved first: it can supply the thread, so
	// an agent replying to a remark need not also work out which card it was on.
	const answered = input.answers ? findMessageById(ctx.db, input.answers) : null;
	if (input.answers && (!answered || answered.deletedAt !== null)) {
		throw notFound(`no such message: ${input.answers}`);
	}

	// Only a caller that named *both* is refused. An anchor inherited from the
	// message being answered is this function's own doing, and refusing it would
	// refuse the ordinary case: answering the owner inside a card's thread.
	if (input.replyTo != null && (input.updateId != null || input.taskId != null)) {
		throw invalid('a reply answers a message, or hangs off an update or a task, not both');
	}

	// The message being replied to, resolved before anything is written, so a
	// reply cannot be filed against a post that is not there.
	const named = input.replyTo ?? null;
	const target = named === null ? null : findMessageById(ctx.db, named);
	if (named !== null && !target) throw notFound(`no such message: ${named}`);

	const updateId = input.updateId ?? answered?.updateId ?? target?.updateId ?? null;
	const taskId = input.taskId ?? answered?.taskId ?? target?.taskId ?? null;
	if (updateId !== null && taskId !== null) {
		throw invalid('a message hangs off an update or a task, not both');
	}

	/**
	 * Answering a reply files the answer under the same post.
	 *
	 * This used to be a refusal, and that was wrong in a way only use could show:
	 * the owner replies *inside* a thread, so what they said is itself a reply —
	 * and an agent trying to answer them got `invalid_argument` for doing the
	 * obvious thing. A rule that makes the owner unanswerable is not protecting
	 * anything.
	 *
	 * Flattening keeps what the rule was actually for. Threads stay one level, so
	 * there is still nothing to render recursively, and the conversation is one
	 * list under the post it belongs to rather than a tree.
	 */
	/**
	 * **Replying to a message that lives in a card's thread keeps that thread.**
	 *
	 * The bug this fixes made the owner's own report: "agents post messages, I
	 * click the notification, and it doesn't take me to the message, nor can I
	 * find it anywhere on the dashboard." They were right, and it was worse than
	 * a broken link — the message was rendered nowhere at all.
	 *
	 * The owner replies *inside* a card's thread, so their line carries that
	 * card's `update_id`. An agent answering it named it as `reply_to`, and
	 * flattening then treated it as the head of a feed thread: the answer got
	 * `reply_to` and no `update_id`, which put it in no thread the browser reads.
	 * `listThread` filters by the card, feed posts are messages with no
	 * `reply_to`, and replies-under-a-post are only collected for posts. So it
	 * existed, notified, and appeared nowhere.
	 *
	 * A message that is already in a card's or a task's thread is answered by
	 * *joining* that thread and naming what it answers (migration 020), which is
	 * exactly what the owner asked for two features ago. Flattening still applies
	 * where it was meant to: under one of their own feed posts, which anchors to
	 * nothing else.
	 */
	const inThread = Boolean(target && (target.updateId !== null || target.taskId !== null));
	const parent = inThread
		? null
		: target?.replyTo
			? findMessageById(ctx.db, target.replyTo)
			: target;
	// Answering a message takes its thread. When that message *is* the head of a
	// thread — one of the owner's feed posts, which anchors to nothing — the
	// answer goes underneath it rather than beside it as a second post: naming a
	// post and being filed next to it is the one reading nobody wants.
	const anchor =
		parent?.id ?? (answered && !inThread ? (answered.replyTo ?? threadHead(answered)) : null);

	// The named project first, so an unknown slug is refused before anything else,
	// and then the anchor's. A request that says both and disagrees is refused
	// rather than quietly resolved: silently preferring one would file the message
	// somewhere the caller did not ask for and report success.
	const namedProject = input.project ? resolveProject(ctx, input.project).id : null;
	// A reply belongs to whatever its post belonged to, which is the same rule an
	// update or a task anchor keeps.
	// A reply belongs to whatever its post belonged to, and an answer to whatever
	// it answered: a message that inherited its thread must not lose the project
	// on the way, or it lands in no feed at all.
	const anchored = parent
		? parent.projectId
		: (anchorProject(ctx, { updateId, taskId }) ?? answered?.projectId ?? null);
	if (anchored !== null && namedProject !== null && anchored !== namedProject) {
		throw invalid('that update, task or message belongs to a different project');
	}
	const projectId = anchored ?? namedProject;

	// Checked before the insert, so a message is never posted without the images
	// it was written about.
	const mediaIds =
		input.mediaIds && input.mediaIds.length > 0
			? assertAttachableToMessage(ctx, { mediaIds: input.mediaIds, author })
			: [];

	// An answer lands in the thread it was addressed to, which is what "keep it
	// all in one thread" means: naming a comment on a card does not start a
	// second conversation somewhere else.
	if (answered && !sameThread(answered, { updateId, taskId, replyTo: anchor })) {
		throw invalid('that message is in a different thread');
	}

	// Answering a line in a card's thread is recorded as answering it — the label
	// the thread renders — rather than as a `reply_to` that would move it out of
	// the thread it was written in.
	const answersId = answered?.id ?? (inThread ? (target?.id ?? null) : null);

	const message = insertMessage(ctx.db, {
		projectId,
		updateId,
		taskId,
		replyTo: anchor,
		answers: answersId,
		author,
		body,
		createdAt: ctx.now()
	});

	if (mediaIds.length > 0) {
		attachMediaToMessage(ctx.db, { mediaIds, messageId: message.id, author });
	}

	ctx.bus.publish('message.created', {
		messageId: message.id,
		projectId: message.projectId,
		author: message.author
	});

	return message;
}

export type DeleteMessageInput = {
	messageId: string;
	/**
	 * Who is asking. Adapters resolve the owner from the session cookie and an
	 * agent from its bearer token, never from an argument on the request — the
	 * whole of this rule is "who are you", so a caller that could say would be a
	 * caller that could delete anybody's words.
	 */
	by: MessageAuthor;
};

/**
 * Delete a message, and tell the browsers that rendered it (migration 017).
 *
 * Two callers, two different permissions, one function:
 *
 * - **The owner deletes anything.** It is their dashboard and their feed —
 *   they already delete an agent's update — and a probe they typed to test a
 *   bug is exactly the litter this exists to clear.
 * - **An agent deletes only what it wrote.** "Unsend" is taking your own words
 *   back; an agent that could delete the owner's message could delete the
 *   instruction it did not want to follow, and the owner would have no way to
 *   tell that from a message they never sent.
 *
 * **Replies go with the post.** A reply under a line nobody can read is not a
 * conversation, so deleting a post soft-deletes its replies too — including
 * replies somebody else wrote, which is the one place the ownership rule bends.
 * It bends the right way: the thread belongs to the post, and leaving orphans
 * behind would show an answer to a question that is gone.
 *
 * Idempotent and quiet the second time, as {@link deleteUpdate} is: the row is
 * already gone from every thread, so a second `message.deleted` would announce
 * nothing.
 *
 * Images stay attached to the deleted row rather than being cut loose, which is
 * what a deleted update does with its own. The sweeper only collects media
 * attached to nothing, so this trades a little disk for the ability to undo a
 * delete later without having shredded what it was about.
 *
 * @throws {DomainError} `not_found` for an unknown message,
 *   `invalid_argument` for an agent deleting somebody else's.
 */
export function deleteMessage(ctx: DomainContext, input: DeleteMessageInput): Message {
	const message = findMessageById(ctx.db, input.messageId);
	if (!message) throw notFound(`no such message: ${input.messageId}`);
	if (message.deletedAt !== null) return message;

	const by = authorText(assertAuthor(ctx, input.by));
	if (by !== HUMAN_AUTHOR && by !== message.author) {
		// `invalid_argument`, as `editUpdate` refuses another agent's update: the
		// same rule, said the same way, so an agent gets one answer for "those are
		// not your words" wherever it meets it.
		throw invalid('that message was posted by somebody else');
	}

	const at = ctx.now();
	// Read before the delete: afterwards they are no longer live and the query
	// that finds them would come back empty.
	const replies = message.replyTo === null ? listRepliesTo(ctx.db, message.id) : [];
	softDeleteMessage(ctx.db, message.id, at);
	for (const reply of replies) softDeleteMessage(ctx.db, reply.id, at);

	ctx.bus.publish('message.deleted', {
		messageId: message.id,
		projectId: message.projectId,
		replies: replies.length
	});

	return findMessageById(ctx.db, message.id)!;
}

/**
 * Record that messages reached an agent, and say so (migration 018).
 *
 * Called by the live stream at the moment it writes them out, which is the
 * only place that knows delivery happened. Two things follow from that:
 *
 * - **The owner can see it.** "delivered to scout" appears under their words
 *   within a second, and the gap between "unread" and "acknowledged" — where a
 *   message might have reached nobody at all — stops being invisible.
 * - **The stream stops repeating itself.** Announcing once used to be
 *   remembered per connection, which is right until the connection drops or the
 *   process restarts, and then the whole unread pile goes out again. A row
 *   survives both.
 *
 * Delivery is not reading. Only `get_messages` moves a read cursor, so a
 * delivered message is still unread, still counted, and still handed over when
 * the agent asks for it.
 *
 * `clientId` is the connection that was handed it (migration 019). Two sessions
 * sharing a token are two clients and both are told; one session reconnecting
 * keeps its id and is not told twice.
 *
 * Silent for anything already delivered: the same push over a new connection is
 * the same fact, and an event for it would make a card flicker for nothing.
 *
 * @returns the deliveries this call created, in the order they were named.
 */
export function markMessagesDelivered(
	ctx: DomainContext,
	input: { agentId: string; messageIds: readonly string[]; clientId?: string | null }
): MessageDelivery[] {
	const created: MessageDelivery[] = [];

	for (const messageId of input.messageIds) {
		const message = findMessageById(ctx.db, messageId);
		// A message deleted between the read and this write is not delivered to
		// anybody: the row would outlive what it describes.
		if (!message || message.deletedAt !== null) continue;

		const { delivery, created: first } = recordDelivery(ctx.db, {
			messageId,
			agentId: input.agentId,
			clientId: input.clientId ?? null,
			at: ctx.now()
		});
		if (!first) continue;

		created.push(delivery);
		ctx.bus.publish('message.delivered', {
			messageId: delivery.messageId,
			agentId: delivery.agentId,
			projectId: message.projectId
		});
	}

	return created;
}

/**
 * Which of these messages one **connection** has already been handed
 * (migrations 018, 019).
 *
 * Per client rather than per agent, because two sessions can share a bearer
 * token: asking whether the agent had seen it let one live session go silent
 * while another connection — a dead session's, in the case that found this —
 * held the only delivery there was.
 *
 * A caller with no client id gets nothing back and is expected to remember
 * within its own connection.
 */
export function alreadyDelivered(
	ctx: DomainContext,
	agentId: string,
	clientId: string | null,
	messageIds: readonly string[]
): Set<string> {
	return deliveredMessageIds(ctx.db, agentId, clientId, messageIds);
}

/**
 * Every delivery on a page of messages, for the browser that renders them.
 *
 * Read in the same request as the messages, exactly as acknowledgements are: a
 * "delivered" that painted a beat after the line it belongs to would read as
 * having just happened rather than as having happened when it did.
 */
export function deliveriesFor(
	ctx: DomainContext,
	messageIds: readonly string[]
): MessageDelivery[] {
	return listDeliveries(ctx.db, messageIds);
}

/**
 * One message by id, deleted or not.
 *
 * For adapters that hold an id and need the row — the agent stream deciding
 * whether a reaction is on something this agent wrote, for instance. `$http`
 * may see the domain and nothing below it (design §2), so the lookup is
 * exported here rather than reached for in `$db`.
 */
export function findMessage(ctx: DomainContext, messageId: string): Message | undefined {
	return findMessageById(ctx.db, messageId);
}

/**
 * Every message in the same conversation as this one.
 *
 * "The same conversation" is whichever anchor it has: a card's thread, a task's
 * thread, or a feed post and its replies. Used to decide who a reaction is news
 * for — an emoji on a line in a thread is feedback for whoever is *in* that
 * thread, not only for whoever wrote the line it landed on.
 */
export function threadOf(ctx: DomainContext, message: Message): Message[] {
	if (message.updateId !== null) return listThread(ctx, { updateId: message.updateId });
	if (message.taskId !== null) return listThread(ctx, { taskId: message.taskId });

	// A feed post: the post itself, and everything hanging off it.
	const root = message.replyTo ?? message.id;
	const inProject = message.projectId
		? listMessages(ctx.db, { projectId: message.projectId, limit: MAX_MESSAGE_LIMIT })
		: [];
	return inProject.filter((candidate) => candidate.id === root || candidate.replyTo === root);
}

export type ReadMessagesInput = {
	/**
	 * The agent reading. Adapters resolve this from the bearer token and never
	 * from a caller-supplied argument (design §5).
	 */
	agentId: string;
	/**
	 * Read from here instead of from the agent's own cursor. A `cursor` from a
	 * previous read; opaque to the caller.
	 */
	since?: string | null;
	/** A project slug or id. Omit for every message waiting. */
	project?: string | null;
	/** Defaults to true, and advances the agent's cursor (design §5). */
	markRead?: boolean;
	/** Defaults to {@link DEFAULT_MESSAGE_LIMIT}, capped at {@link MAX_MESSAGE_LIMIT}. */
	limit?: number;
};

/** One read: what was waiting, where the agent got to, and what is left. */
export type MessagePage = {
	/** Oldest first: a conversation being caught up on, not a feed. */
	messages: Message[];
	/** Pass back as `since`. */
	cursor: string;
	/** How many messages are still unread *after* this call, in every project. */
	unread: number;
	/** Whether this call moved the agent's cursor. */
	markedRead: boolean;
};

/**
 * What is waiting for one agent.
 *
 * An agent never reads its own messages back: they are in the same table as the
 * owner's, and a reply the agent wrote is not news to it.
 *
 * @throws {DomainError} `not_found` for an unknown agent or project,
 *   `invalid_argument` for a bad limit or a cursor this server did not issue.
 */
export function readMessages(ctx: DomainContext, input: ReadMessagesInput): MessagePage {
	const agent = findAgentById(ctx.db, input.agentId);
	if (!agent) throw notFound(`no such agent: ${input.agentId}`);

	const mine = authorText({ kind: 'agent', agentId: agent.id });
	const limit = pageLimit(input.limit);
	const projectId = input.project ? resolveProject(ctx, input.project).id : undefined;
	/**
	 * **An agent's inbox is the projects it works in.**
	 *
	 * This used to be every message in the deployment, and the owner found what
	 * that means the moment they had two agents: a message they typed in their
	 * work project was handed to the Mega Merge agent, which answered it — "that
	 * isn't me, you've got the wrong agent". It was right, and it should never
	 * have been asked.
	 *
	 * A message belongs to a *project*, not to an agent, so relevance has to be
	 * derived — and it is derived exactly as the live stream derives it
	 * ({@link projectsForAgent}): from what this agent has actually done. An
	 * agent that has done nothing yet still hears everything, because a new agent
	 * must not be deaf to the first thing ever said to it.
	 *
	 * An explicit `project` still wins: asking for one is asking for that one.
	 */
	const worksIn = projectsForAgent(ctx, agent.id);
	const scope = projectId === undefined ? worksIn : [projectId];
	const cursorSeq = readCursorSeq(ctx.db, agent.id);
	const from = decodeCursor(input.since) ?? cursorSeq;

	const messages = listMessages(ctx.db, {
		afterSeq: from,
		excludeAuthor: mine,
		limit,
		...(scope ? { projectIds: scope } : {})
	});

	const markRead = input.markRead ?? true;
	if (markRead) {
		// The cursor is protected against *this agent's* unread, not against the
		// narrower slice it happened to ask for: a message in a project it does
		// not work in is not a message it is waiting for, and refusing to step
		// over one would freeze the cursor behind another agent's conversation for
		// ever — which is what left this agent's inbox permanently "unread".
		const to = readTo(ctx, {
			cursorSeq,
			from,
			mine,
			limit,
			projectId,
			scope: worksIn,
			messages
		});
		advanceReadCursor(ctx.db, agent.id, to);
		// Announced, unlike every other read in this file, because it is the one
		// that changes state somebody else is watching: an agent's unread count is
		// on its own live stream (`src/http/stream/agent.ts`), and a count that
		// falls in silence leaves every listener holding a stale figure that makes
		// the *next* real message look like a fall.
		if (to > cursorSeq) ctx.bus.publish('messages.read', { agentId: agent.id, cursor: to });
	}

	const last = messages.at(-1);
	return {
		messages,
		cursor: encodeCursor(last ? last.seq : from),
		// Counted in the same scope it was read in: a number that includes messages
		// this agent will never be handed is a number that says "call me again"
		// for ever.
		unread: countUnreadMessages(ctx, agent.id),
		markedRead: markRead
	};
}

/**
 * How many messages one agent has not read (design §5).
 *
 * The count the heartbeat piggybacks, and it is scoped to the projects this
 * agent works in — the same scope {@link readMessages} hands over. It used to
 * span the deployment, on the theory that "is there anything for me anywhere"
 * must not be answered narrowly; with more than one agent that theory produced
 * a count of work belonging to somebody else, and an agent that fetched it was
 * handed another agent's owner conversation.
 *
 * An agent with no history counts everything, which is the same "a new agent is
 * not deaf" rule the read keeps.
 */
export function countUnreadMessages(ctx: DomainContext, agentId: string): number {
	const scope = projectsForAgent(ctx, agentId);
	return countMessagesAfter(ctx.db, readCursorSeq(ctx.db, agentId), {
		excludeAuthor: authorText({ kind: 'agent', agentId }),
		...(scope ? { projectIds: scope } : {})
	});
}

/**
 * The projects one agent actually works in (design §5).
 *
 * Derived from what it has done — updates posted, tasks handed to it, threads
 * it has spoken in — because this product has no notion of membership: an agent
 * is not added to a project, it simply works in one. Deriving it means nothing
 * to configure and nothing to forget.
 *
 * `null` for an agent with no history at all, which callers read as "everything
 * is relevant". A new agent must not be deaf to the first message ever sent to
 * it, and the moment it does anything the list stops being empty.
 */
export function projectsForAgent(ctx: DomainContext, agentId: string): string[] | null {
	const projects = listAgentProjectIds(ctx.db, agentId, authorText({ kind: 'agent', agentId }));
	return projects.length === 0 ? null : projects;
}

/**
 * Unread messages, counting only the projects this agent works in (design §5).
 *
 * Deliberately *not* what {@link countUnreadMessages} does, and the difference
 * is the point. A heartbeat answers "is there anything for me anywhere", which
 * has to span every project or it would be a no that means yes. A live stream
 * answers "should I interrupt this agent right now", and waking an agent for a
 * project it has never touched is the interruption nobody wanted.
 */
export function countUnreadMessagesInScope(
	ctx: DomainContext,
	agentId: string,
	/**
	 * What the caller has explicitly subscribed to.
	 *
	 * An explicit answer always wins over the derived one: an agent that once
	 * posted in another project has no business being woken by it afterwards, and
	 * only the agent can say what it is currently for.
	 *
	 * - a **list** — only those projects.
	 * - **`null`** — every project, asked for explicitly. Not the same as
	 *   `undefined`: this is a session that wants the lot, including projects the
	 *   agent has never touched.
	 * - **`undefined`** — no opinion, so work it out from what I have done.
	 */
	subscribed?: readonly string[] | null
): number {
	const projectIds = subscribed === undefined ? projectsForAgent(ctx, agentId) : subscribed;
	return countMessagesAfter(ctx.db, readCursorSeq(ctx.db, agentId), {
		excludeAuthor: authorText({ kind: 'agent', agentId }),
		...(projectIds ? { projectIds } : {})
	});
}

/**
 * The unread messages themselves, scoped as {@link countUnreadMessagesInScope}.
 *
 * Read-only: it does not move the cursor, because the caller is a stream
 * deciding what to announce, not an agent catching up. `get_messages` remains
 * the only thing that marks anything read.
 */
export function unreadMessagesInScope(
	ctx: DomainContext,
	agentId: string,
	limit = 10,
	/** As {@link countUnreadMessagesInScope}: an explicit subscription wins, and `null` is every project. */
	subscribed?: readonly string[] | null
): Message[] {
	const projectIds = subscribed === undefined ? projectsForAgent(ctx, agentId) : subscribed;
	const mine = authorText({ kind: 'agent', agentId });
	const after = readCursorSeq(ctx.db, agentId);

	// The scope goes **into the query**, not over its result. Filtering a page
	// afterwards is how this went silent: the cursor sat behind a run of messages
	// in other projects, so the first `limit` unread were all somewhere else and
	// the scoped read came back empty — while the scoped *count* said there was
	// something waiting. The channel then held a notification for a message frame
	// that could never arrive.
	return listMessages(ctx.db, {
		afterSeq: after,
		excludeAuthor: mine,
		limit,
		// The **newest** few, not the oldest. A notification is about what just
		// arrived, and the read cursor only moves when the agent calls
		// `get_messages` — so on a long unread list the oldest window is frozen,
		// and every new message lands outside it. That is how the owner's newest
		// message stopped being announced while five old ones repeated.
		newest: true,
		...(projectIds ? { projectIds } : {})
	});
}

export type ThreadQuery = {
	/** One update's thread — what a card renders inline (design §7). */
	updateId?: string;
	/** One task's thread. */
	taskId?: string;
	/** A project slug or id: every message in it, its cards' threads included. */
	project?: string;
	/** Defaults to {@link MAX_MESSAGE_LIMIT}. */
	limit?: number;
};

/**
 * A thread as the owner's browser reads it: oldest first, newest kept.
 *
 * Unlike {@link readMessages} this has no cursor and no side effect — the owner
 * is looking at the page, not catching up through a tool — and it is the *newest*
 * messages that are kept when there are more than the cap allows, because the
 * bottom of a conversation is the part being read.
 *
 * Reaching that ordering costs a walk rather than a `DESC` query: `$db` reads
 * messages oldest first (a conversation is caught up on, not scrolled back
 * through), so a batch at a time is stepped through and only the last window is
 * kept. One query per `limit` rows, which at this product's scale (§1: one
 * owner, tens of agents) is a query or two.
 */
export function listThread(ctx: DomainContext, query: ThreadQuery): Message[] {
	const limit = pageLimit(query.limit ?? MAX_MESSAGE_LIMIT);
	const scope = {
		updateId: query.updateId,
		taskId: query.taskId,
		projectId: query.project ? resolveProject(ctx, query.project).id : undefined
	};

	let window: Message[] = [];
	let afterSeq = 0;
	for (;;) {
		const batch = listMessages(ctx.db, { ...scope, afterSeq, limit });
		if (batch.length === 0) return window;

		window = batch.length >= limit ? batch : [...window, ...batch].slice(-limit);
		if (batch.length < limit) return window;
		afterSeq = batch[batch.length - 1].seq;
	}
}

/**
 * How far this read may move the cursor.
 *
 * The plain answer is "to the last message handed over". The exception is the
 * point of this function: a read narrowed by a project, or started from an
 * explicit `since`, may have stepped over messages the agent has still never
 * seen, and the cursor may not pass those — the heartbeat's unread count is the
 * same comparison, so a cursor that jumped them would drop them silently.
 *
 * So when the read was narrowed, the earliest unread message it did *not* return
 * is looked up and the cursor stops just short of it. That costs one extra
 * indexed query, and only on a narrowed read.
 */
function readTo(
	ctx: DomainContext,
	args: {
		cursorSeq: number;
		from: number;
		mine: string;
		limit: number;
		projectId: string | undefined;
		/** The projects this read covered, or `null` for every one. */
		scope: string[] | null;
		messages: Message[];
	}
): number {
	const last = args.messages.at(-1)?.seq ?? args.from;
	const narrowed = args.projectId !== undefined || args.from !== args.cursorSeq;
	if (!narrowed) return last;

	// Everything unread *in this agent's scope*, in order, up to the same page
	// size. If the first `limit` of those are exactly what was handed over,
	// nothing was stepped over: the two lists are the same rows. Scoped, because
	// a message in a project this agent does not work in is not a message it is
	// waiting for, and stopping the cursor short of one would freeze it for ever.
	const unread = listMessages(ctx.db, {
		afterSeq: args.cursorSeq,
		excludeAuthor: args.mine,
		limit: args.limit,
		...(args.scope ? { projectIds: args.scope } : {})
	});
	const handed = new Set(args.messages.map((message) => message.id));
	const skipped = unread.find((message) => !handed.has(message.id));

	return skipped ? Math.min(last, skipped.seq - 1) : last;
}

/** A message that heads a thread rather than sitting in one: an id, or null. */
function threadHead(message: Message): string | null {
	return message.updateId === null && message.taskId === null ? message.id : null;
}

/**
 * Whether an answer would land beside the comment it answers.
 *
 * A feed post's replies all carry the post's id, a card's thread all carry the
 * card's, so "same thread" is the anchor matching — with one allowance: a reply
 * may answer *the post itself*, which anchors to nothing and is the head of the
 * thread rather than a member of it.
 */
function sameThread(
	answered: Message,
	here: { updateId: string | null; taskId: string | null; replyTo: string | null }
): boolean {
	if (here.replyTo !== null && answered.id === here.replyTo) return true;
	return (
		answered.updateId === here.updateId &&
		answered.taskId === here.taskId &&
		(answered.replyTo ?? null) === here.replyTo
	);
}

/** The author, checked: an agent that does not exist cannot have said anything. */
function assertAuthor(ctx: DomainContext, author: MessageAuthor): MessageAuthor {
	if (author.kind === 'human') return author;
	if (!findAgentById(ctx.db, author.agentId)) {
		throw notFound(`no such agent: ${author.agentId}`);
	}
	return author;
}

/**
 * The project an anchor puts a message in.
 *
 * A deleted update is `not_found` rather than a silent thread nobody can see: it
 * is gone from every timeline (design §3), so a reply on it would be written to
 * a card the owner can no longer read.
 */
function anchorProject(
	ctx: DomainContext,
	anchor: { updateId: string | null; taskId: string | null }
): string | null {
	if (anchor.updateId !== null) {
		const update = findUpdateById(ctx.db, anchor.updateId);
		if (!update || update.deletedAt !== null) throw notFound(`no such update: ${anchor.updateId}`);
		return update.projectId;
	}

	if (anchor.taskId !== null) {
		const task = findTaskById(ctx.db, anchor.taskId);
		if (!task) throw notFound(`no such task: ${anchor.taskId}`);
		return task.projectId;
	}

	return null;
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_MESSAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
	return Math.min(limit, MAX_MESSAGE_LIMIT);
}

/** Cursors are opaque to callers, which is why they are encoded and decoded here. */
function encodeCursor(seq: number): string {
	return String(seq);
}

function decodeCursor(cursor: string | null | undefined): number | undefined {
	if (cursor === undefined || cursor === null || cursor === '') return undefined;
	if (!/^[0-9]+$/.test(cursor)) throw invalid('since is not a cursor this server issued');
	return Number(cursor);
}
