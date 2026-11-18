import { beforeEach, describe, expect, it } from 'vitest';
import { findMessageById, readCursorSeq } from '$db';
import { harness, type Harness } from '$domain/testing';
import { isDomainError } from './errors';
import {
	AGENT_AUTHOR_PREFIX,
	HUMAN_AUTHOR,
	MESSAGE_BODY_MAX_LENGTH,
	authorText,
	countUnreadMessages,
	countUnreadMessagesInScope,
	unreadMessagesInScope,
	listThread,
	parseAuthor,
	alreadyDelivered,
	deleteMessage,
	deliveriesFor,
	markMessagesDelivered,
	editMessage,
	postMessage,
	readMessages,
	answeredMessage,
	authorName,
	QUOTED_MAX_LENGTH
} from './messages';
import { createProject } from './projects';
import { createRequest } from './requests';
import { postUpdate } from './updates';

let h: Harness;
let agentId: string;
let projectId: string;
let slug: string;

/** The code a refusal carried, or the error itself if it was not a domain one. */
function refusalCode(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	throw new Error('expected a refusal');
}

/** The owner says something, scoped to whatever the test is about. */
function fromOwner(body: string, scope: Record<string, string> = {}) {
	return postMessage(h, { author: { kind: 'human' }, body, ...scope });
}

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	const project = createProject(h, { name: 'Agent Dashboard' }).project;
	projectId = project.id;
	slug = project.slug;
});

describe('the author string', () => {
	it('is the literal human, or agent:<agent_id> (design §3)', () => {
		expect(authorText({ kind: 'human' })).toBe(HUMAN_AUTHOR);
		expect(authorText({ kind: 'agent', agentId: 'a1' })).toBe(`${AGENT_AUTHOR_PREFIX}a1`);
	});

	it('reads back what it wrote, and refuses to guess at anything else', () => {
		expect(parseAuthor('human')).toEqual({ kind: 'human' });
		expect(parseAuthor('agent:a1')).toEqual({ kind: 'agent', agentId: 'a1' });
		expect(parseAuthor('agent:')).toBeNull();
		expect(parseAuthor('somebody')).toBeNull();
	});
});

describe('posting a message', () => {
	it('scopes one to a project, from the owner', () => {
		const message = fromOwner('ship it', { project: slug });

		expect(message).toMatchObject({
			author: HUMAN_AUTHOR,
			body: 'ship it',
			projectId,
			updateId: null,
			taskId: null
		});
		expect(findMessageById(h.db, message.id)).toMatchObject({ body: 'ship it' });
	});

	it('scopes one to an update, and derives the project from it', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'done' });

		const message = fromOwner('nice', { updateId: update.id });

		expect(message).toMatchObject({ updateId: update.id, projectId, taskId: null });
	});

	it('lets an agent reply, as agent:<agent_id>', () => {
		const message = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'on it',
			project: slug
		});

		expect(message.author).toBe(`${AGENT_AUTHOR_PREFIX}${agentId}`);
	});

	it('publishes exactly one message.created, carrying the id and the project', () => {
		const message = fromOwner('ship it', { project: slug });

		expect(h.eventNames()).toEqual(['project.created', 'message.created']);
		expect(h.events.at(-1)!.payload).toEqual({
			messageId: message.id,
			projectId,
			author: HUMAN_AUTHOR,
			// Which thread it is in, so a client re-reads only that one.
			updateId: null,
			replyTo: null,
			requestId: null,
			taskId: null
		});
	});

	it('refuses a blank body, an over-long one, and an unknown scope', () => {
		expect(refusalCode(() => fromOwner('   ', { project: slug }))).toBe('invalid_argument');
		expect(refusalCode(() => fromOwner('x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1)))).toBe(
			'invalid_argument'
		);
		expect(refusalCode(() => fromOwner('hi', { updateId: 'nope' }))).toBe('not_found');
		expect(refusalCode(() => fromOwner('hi', { project: 'nope' }))).toBe('not_found');
	});

	it('refuses an agent that does not exist, so a message cannot be attributed to nobody', () => {
		expect(
			refusalCode(() => postMessage(h, { author: { kind: 'agent', agentId: 'ghost' }, body: 'hi' }))
		).toBe('not_found');
	});

	it('refuses an update that belongs to a different project than the one named', () => {
		const other = createProject(h, { name: 'Other' }).project;
		const update = postUpdate(h, { project: other.slug, agentId, body: 'done' });

		expect(refusalCode(() => fromOwner('hi', { updateId: update.id, project: slug }))).toBe(
			'invalid_argument'
		);
	});
});

describe('reading messages as an agent', () => {
	it('returns only what is after the agent’s cursor', () => {
		fromOwner('first', { project: slug });
		fromOwner('second', { project: slug });

		const first = readMessages(h, { agentId });
		expect(first.messages.map((message) => message.body)).toEqual(['first', 'second']);

		// The cursor moved, so a second read with nothing new returns nothing.
		expect(readMessages(h, { agentId }).messages).toEqual([]);

		fromOwner('third', { project: slug });
		expect(readMessages(h, { agentId }).messages.map((message) => message.body)).toEqual(['third']);
	});

	it('advances the cursor when it marks read, and leaves it alone otherwise', () => {
		fromOwner('first', { project: slug });

		const peek = readMessages(h, { agentId, markRead: false });

		expect(peek.messages).toHaveLength(1);
		expect(peek.markedRead).toBe(false);
		expect(readCursorSeq(h.db, agentId, projectId)).toBe(0);
		// The same messages come back, because nothing was read.
		expect(readMessages(h, { agentId, markRead: false }).messages).toHaveLength(1);

		const read = readMessages(h, { agentId });
		expect(read.markedRead).toBe(true);
		// A cursor per project (migration 025), so it is that project's row that moved.
		expect(readCursorSeq(h.db, agentId, projectId)).toBe(read.messages.at(-1)!.seq);
	});

	it('never hands an agent its own messages back', () => {
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'mine', project: slug });
		fromOwner('yours', { project: slug });

		expect(readMessages(h, { agentId }).messages.map((message) => message.body)).toEqual(['yours']);
	});

	it('reads one project at a time without marking the rest read', () => {
		const other = createProject(h, { name: 'Other' }).project;
		fromOwner('for other', { project: other.slug });
		fromOwner('for dashboard', { project: slug });

		const scoped = readMessages(h, { agentId, project: slug });

		expect(scoped.messages.map((message) => message.body)).toEqual(['for dashboard']);
		// A cursor per project (migration 025): this read moved the dashboard's and
		// left the other project's exactly where it was. The message it stepped over
		// is still unread and still comes back — the point of the change, since one
		// shared integer used to make it unreadable for ever once another session
		// dragged it past.
		expect(scoped.unread).toBe(1);
		expect(readMessages(h, { agentId }).messages.map((message) => message.body)).toEqual([
			'for other'
		]);
		// And once every cursor has passed, nothing comes back again.
		expect(readMessages(h, { agentId }).messages).toEqual([]);
	});

	it('does not let a read in one project mark another project’s messages read', () => {
		const other = createProject(h, { name: 'Other' }).project;
		fromOwner('for other', { project: other.slug });
		fromOwner('for dashboard', { project: slug });

		readMessages(h, { agentId, project: slug });

		// The exact failure the owner reported twice: a second session reading its
		// own project used to leave this one announceable to nobody.
		expect(
			unreadMessagesInScope(h, agentId, 10, [other.id]).map((message) => message.body)
		).toEqual(['for other']);
	});

	it('resumes from an explicit cursor, and still cannot skip what is unread', () => {
		const first = fromOwner('first', { project: slug });
		fromOwner('second', { project: slug });

		const ahead = readMessages(h, { agentId, since: String(first.seq) });

		expect(ahead.messages.map((message) => message.body)).toEqual(['second']);
		// `first` was never handed over, so the cursor stays behind it and both are
		// still unread. Reading ahead is a peek, not a skip.
		expect(ahead.unread).toBe(2);
		expect(readMessages(h, { agentId }).messages.map((message) => message.body)).toEqual([
			'first',
			'second'
		]);
	});

	it('hands back a cursor to pass in as since', () => {
		fromOwner('first', { project: slug });
		const page = readMessages(h, { agentId, markRead: false });

		expect(page.cursor).toBe(String(page.messages.at(-1)!.seq));
		expect(readMessages(h, { agentId, since: page.cursor, markRead: false }).messages).toEqual([]);
	});

	it('caps and validates the page size, and refuses a cursor it did not issue', () => {
		expect(refusalCode(() => readMessages(h, { agentId, limit: 0 }))).toBe('invalid_argument');
		expect(refusalCode(() => readMessages(h, { agentId, since: 'later' }))).toBe(
			'invalid_argument'
		);
		expect(refusalCode(() => readMessages(h, { agentId: 'ghost' }))).toBe('not_found');
	});
});

describe('the unread count the heartbeat carries', () => {
	it('counts what is after the cursor and not the agent’s own words', () => {
		expect(countUnreadMessages(h, agentId)).toBe(0);

		fromOwner('first', { project: slug });
		fromOwner('second', { project: slug });
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'mine', project: slug });

		expect(countUnreadMessages(h, agentId)).toBe(2);

		readMessages(h, { agentId });
		expect(countUnreadMessages(h, agentId)).toBe(0);
	});

	it('is per agent: one reading does not read for another', () => {
		const other = h.agent('other');
		fromOwner('for everyone', { project: slug });

		readMessages(h, { agentId });

		expect(countUnreadMessages(h, agentId)).toBe(0);
		expect(countUnreadMessages(h, other)).toBe(1);
	});
});

describe('a thread, as the owner’s browser reads it', () => {
	it('is one update’s messages, oldest first', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'done' });
		const elsewhere = postUpdate(h, { project: slug, agentId, body: 'other' });
		fromOwner('first', { updateId: update.id });
		fromOwner('not this one', { updateId: elsewhere.id });
		fromOwner('second', { updateId: update.id });

		expect(listThread(h, { updateId: update.id }).map((message) => message.body)).toEqual([
			'first',
			'second'
		]);
	});

	it('reads a whole project’s messages, including the ones hanging off its updates', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'done' });
		const other = createProject(h, { name: 'Other' }).project;
		fromOwner('on the card', { updateId: update.id });
		fromOwner('on the project', { project: slug });
		fromOwner('elsewhere', { project: other.slug });

		expect(listThread(h, { project: slug }).map((message) => message.body)).toEqual([
			'on the card',
			'on the project'
		]);
	});

	it('keeps the newest when there are more messages than the cap allows', () => {
		for (let n = 1; n <= 7; n += 1) fromOwner(`m${n}`, { project: slug });

		expect(listThread(h, { project: slug, limit: 3 }).map((message) => message.body)).toEqual([
			'm5',
			'm6',
			'm7'
		]);
	});

	/**
	 * The owner: "it's like the entire card has disappeared."
	 *
	 * A post from weeks ago that somebody answered this morning is older than the
	 * cap, so the cut kept the replies and dropped the post they hang off — and a
	 * reply with no post is drawn nowhere.
	 */
	it('brings back a post the cut dropped, when its replies survived', () => {
		const post = fromOwner('the question nobody forgot', { project: slug });
		for (let n = 1; n <= 5; n += 1) fromOwner(`filler ${n}`, { project: slug });
		const answer = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'answered at last'
		});

		const read = listThread(h, { project: slug, limit: 3 });

		// The window itself is still the newest three; the post is put back in
		// front of them because something in it points at it.
		expect(read.map((message) => message.id)).toContain(post.id);
		expect(read.map((message) => message.id)).toContain(answer.id);
		// Oldest first, as the rest of the page is.
		expect(read[0].id).toBe(post.id);
	});

	it('does not resurrect a deleted post, which takes its thread with it', () => {
		const post = fromOwner('going away', { project: slug });
		postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'still here'
		});
		deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(listThread(h, { project: slug, limit: 2 }).map((message) => message.id)).not.toContain(
			post.id
		);
	});
});

/**
 * The owner's own feed posts, and replies to them (migration 014).
 *
 * A post anchors to nothing — it is the thing being discussed rather than a
 * comment on something — so a reply names the post directly. One level deep, on
 * purpose: threads of threads are a shape nobody asked for.
 */
describe('replying to a post', () => {
	it('files the reply under the post, in the post’s project', () => {
		const post = fromOwner('have a look at the migration', { project: slug });

		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'on it',
			replyTo: post.id
		});

		expect(reply).toMatchObject({ replyTo: post.id, projectId, updateId: null, taskId: null });
	});

	it('leaves a post itself unanchored, which is what makes it a card', () => {
		const post = fromOwner('a thought', { project: slug });

		expect(post).toMatchObject({ replyTo: null, updateId: null, taskId: null, projectId });
	});

	it('files a reply to a reply under the same post, rather than nesting', () => {
		// This was a refusal, and it was wrong in a way only use could show: the
		// owner replies *inside* a thread, so what they said is itself a reply, and
		// an agent answering them was refused for doing the obvious thing.
		const post = fromOwner('a thought', { project: slug });
		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'on it',
			replyTo: post.id
		});

		const answer = postMessage(h, {
			author: { kind: 'human' },
			body: 'and?',
			replyTo: reply.id
		});

		expect(answer.replyTo).toBe(post.id);
		expect(listThread(h, { project: slug }).filter((m) => m.replyTo === post.id)).toHaveLength(2);
	});

	it('keeps the thread one level deep however far down somebody replies', () => {
		const post = fromOwner('a thought', { project: slug });
		let last = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'one',
			replyTo: post.id
		});

		for (const body of ['two', 'three']) {
			last = postMessage(h, { author: { kind: 'human' }, body, replyTo: last.id });
			expect(last.replyTo).toBe(post.id);
		}
	});

	it('refuses a reply to a message that is not there', () => {
		expect(
			refusalCode(() => postMessage(h, { author: { kind: 'human' }, body: 'hi', replyTo: 'nope' }))
		).toBe('not_found');
	});

	it('refuses a reply that also names an update or a task', () => {
		const post = fromOwner('a thought', { project: slug });
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });

		expect(
			refusalCode(() =>
				postMessage(h, {
					author: { kind: 'human' },
					body: 'both',
					replyTo: post.id,
					updateId: update.id
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses a reply filed against a project the post is not in', () => {
		const post = fromOwner('a thought', { project: slug });
		const other = createProject(h, { name: 'Elsewhere' }).project;

		expect(
			refusalCode(() =>
				postMessage(h, {
					author: { kind: 'human' },
					body: 'wrong project',
					replyTo: post.id,
					project: other.slug
				})
			)
		).toBe('invalid_argument');
	});

	it('reaches an agent the way any other message does', () => {
		fromOwner('have a look at this', { project: slug });

		// The unread count is what the heartbeat and the channel both report, so a
		// post arriving with no anchor must still be work the agent hears about.
		expect(countUnreadMessages(h, agentId)).toBe(1);
	});
});

/**
 * The bug that made the channel go quiet.
 *
 * `unreadMessagesInScope` took a page of unread messages and *then* filtered it
 * by project. With the cursor sitting behind a run of messages in other
 * projects, the first page was entirely somewhere else, so a subscribed reader
 * got nothing — while the scoped *count* said there was something waiting. The
 * channel held a notification for a message frame that could never arrive, and
 * the owner sent five messages into silence.
 *
 * The scope belongs in the query, not over its result.
 */
describe('reading unread messages in a subscription', () => {
	it('finds a scoped message sitting behind a page of others', () => {
		const elsewhere = createProject(h, { name: 'Somewhere Else' }).project;
		// More than the limit, all in the project this reader is not subscribed to.
		for (let index = 0; index < 8; index += 1) {
			postMessage(h, {
				author: { kind: 'human' },
				body: `other ${index}`,
				project: elsewhere.slug
			});
		}
		fromOwner('the one that matters', { project: slug });

		const found = unreadMessagesInScope(h, agentId, 5, [projectId]);

		expect(found.map((message) => message.body)).toEqual(['the one that matters']);
	});

	it('agrees with the count it is paired with', () => {
		const elsewhere = createProject(h, { name: 'Somewhere Else' }).project;
		for (let index = 0; index < 8; index += 1) {
			postMessage(h, {
				author: { kind: 'human' },
				body: `other ${index}`,
				project: elsewhere.slug
			});
		}
		fromOwner('mine', { project: slug });

		// The pair is the contract: a count that says "something is waiting" and a
		// read that returns nothing is what the channel could not recover from.
		expect(countUnreadMessagesInScope(h, agentId, [projectId])).toBe(1);
		expect(unreadMessagesInScope(h, agentId, 5, [projectId])).toHaveLength(1);
	});

	it('reads nothing for a subscription naming no projects', () => {
		fromOwner('mine', { project: slug });

		expect(unreadMessagesInScope(h, agentId, 5, [])).toEqual([]);
	});

	it('still reads everywhere when nothing is subscribed', () => {
		const elsewhere = createProject(h, { name: 'Somewhere Else' }).project;
		postMessage(h, { author: { kind: 'human' }, body: 'other', project: elsewhere.slug });
		fromOwner('mine', { project: slug });

		expect(unreadMessagesInScope(h, agentId, 5, null)).toHaveLength(2);
	});
});

/**
 * The third face of the same bug: the newest message never reaching the window.
 *
 * The stream's message frame carries at most a handful of unread messages, and
 * it took the *oldest*. The read cursor only moves when an agent calls
 * `get_messages`, so on a long unread list that window is frozen — the owner's
 * newest message lands outside it and is never announced, while the same five
 * old ones are repeated on every rise.
 */
describe('which unread messages a notification carries', () => {
	it('carries the newest, not the oldest', () => {
		for (let index = 0; index < 8; index += 1) {
			fromOwner(`old ${index}`, { project: slug });
		}
		fromOwner('the one that just arrived', { project: slug });

		const found = unreadMessagesInScope(h, agentId, 3, [projectId]);

		expect(found.at(-1)?.body).toBe('the one that just arrived');
		expect(found).toHaveLength(3);
	});

	it('still reads oldest first, so a thread makes sense', () => {
		fromOwner('first', { project: slug });
		fromOwner('second', { project: slug });

		expect(unreadMessagesInScope(h, agentId, 5, [projectId]).map((m) => m.body)).toEqual([
			'first',
			'second'
		]);
	});
});

/**
 * Deleting a message (migration 017).
 *
 * Two callers with two different permissions, and the interesting cases are all
 * about what a delete takes with it: the replies under a post, an agent's unread
 * count, and a thread three tabs are looking at.
 */
/**
 * Correcting what you already said (migration 033).
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 * A thread where every mistake is followed by "sorry, ignore that" is one
 * nobody can skim, and the owner is left working out which line is true.
 */
describe('editing a message', () => {
	it('replaces the words and says that it did', () => {
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			project: slug,
			body: 'the file is src/wrong.ts'
		});

		const edited = editMessage(h, {
			messageId: said.id,
			by: { kind: 'agent', agentId },
			body: 'the file is src/right.ts'
		});

		expect(edited).toMatchObject({ id: said.id, body: 'the file is src/right.ts' });
		expect(edited.editedAt).toBeGreaterThanOrEqual(said.createdAt);
		expect(findMessageById(h.db, said.id)?.body).toBe('the file is src/right.ts');
	});

	it('leaves everything else where it was: the thread, the time, the label', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		const asked = fromOwner('which suite?', { updateId: update.id });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			answers: asked.id,
			body: 'unit'
		});

		const edited = editMessage(h, {
			messageId: said.id,
			by: { kind: 'agent', agentId },
			body: 'unit and browser'
		});

		// A corrected typo must not move the line to another card, or to the
		// bottom of the thread.
		expect(edited).toMatchObject({
			updateId: update.id,
			answers: asked.id,
			createdAt: said.createdAt,
			seq: said.seq
		});
	});

	it('announces it as an edit, never as a new message', () => {
		const said = postMessage(h, { author: { kind: 'agent', agentId }, project: slug, body: 'one' });
		const before = h.eventNames().length;

		editMessage(h, { messageId: said.id, by: { kind: 'agent', agentId }, body: 'two' });

		// A second `message.created` would push it at agents again and buzz the
		// owner's phone about something they have already read.
		expect(h.eventNames().slice(before)).toEqual(['message.updated']);
		expect(h.events.at(-1)!.payload).toMatchObject({ messageId: said.id, projectId });
	});

	it('refuses somebody else`s words', () => {
		const theirs = fromOwner('mine', { project: slug });

		expect(
			refusalCode(() =>
				editMessage(h, { messageId: theirs.id, by: { kind: 'agent', agentId }, body: 'not yours' })
			)
		).toBe('invalid_argument');
		expect(findMessageById(h.db, theirs.id)?.body).toBe('mine');
	});

	it('refuses to rewrite a line that was unsent', () => {
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			project: slug,
			body: 'oops'
		});
		deleteMessage(h, { messageId: said.id, by: { kind: 'agent', agentId } });

		expect(
			refusalCode(() =>
				editMessage(h, { messageId: said.id, by: { kind: 'agent', agentId }, body: 'better' })
			)
		).toBe('not_found');
	});

	it('refuses an empty body, as posting one does', () => {
		const said = postMessage(h, { author: { kind: 'agent', agentId }, project: slug, body: 'one' });

		expect(
			refusalCode(() =>
				editMessage(h, { messageId: said.id, by: { kind: 'agent', agentId }, body: '   ' })
			)
		).toBe('invalid_argument');
	});

	it('lets the owner correct their own line too', () => {
		const theirs = fromOwner('teh build is green', { project: slug });

		expect(
			editMessage(h, { messageId: theirs.id, by: { kind: 'human' }, body: 'the build is green' })
		).toMatchObject({ body: 'the build is green' });
	});
});

describe('deleting a message', () => {
	it('lets the owner delete their own post', () => {
		const post = fromOwner('a probe I no longer need', { project: slug });

		const deleted = deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(deleted.deletedAt).not.toBeNull();
		expect(listThread(h, { project: slug })).toEqual([]);
	});

	it('lets the owner delete an agent’s message, because it is their feed', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'progress' });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'and here is why',
			updateId: update.id
		});

		deleteMessage(h, { messageId: said.id, by: { kind: 'human' } });

		expect(listThread(h, { updateId: update.id })).toEqual([]);
	});

	it('lets an agent unsend what it wrote itself', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'progress' });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'posted too soon',
			updateId: update.id
		});

		deleteMessage(h, { messageId: said.id, by: { kind: 'agent', agentId } });

		expect(listThread(h, { updateId: update.id })).toEqual([]);
	});

	it('refuses an agent deleting somebody else’s words', () => {
		const post = fromOwner('do the thing', { project: slug });

		expect(
			refusalCode(() => deleteMessage(h, { messageId: post.id, by: { kind: 'agent', agentId } }))
		).toBe('invalid_argument');
		expect(findMessageById(h.db, post.id)!.deletedAt).toBeNull();
	});

	it('takes the replies with the post, so no answer is left hanging', () => {
		const post = fromOwner('what about this', { project: slug });
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'on it', replyTo: post.id });

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(listThread(h, { project: slug })).toEqual([]);
		expect(events).toEqual([
			expect.objectContaining({
				type: 'message.deleted',
				payload: {
					messageId: post.id,
					projectId,
					replies: 1,
					updateId: null,
					replyTo: null,
					requestId: null,
					taskId: null
				}
			})
		]);
	});

	it('leaves the post alone when one of its replies goes', () => {
		const post = fromOwner('what about this', { project: slug });
		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'never mind',
			replyTo: post.id
		});

		deleteMessage(h, { messageId: reply.id, by: { kind: 'agent', agentId } });

		expect(listThread(h, { project: slug }).map((message) => message.id)).toEqual([post.id]);
	});

	it('drops a deleted message out of what an agent has waiting', () => {
		const post = fromOwner('ignore me', { project: slug });
		expect(countUnreadMessages(h, agentId)).toBe(1);

		deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(countUnreadMessages(h, agentId)).toBe(0);
		expect(readMessages(h, { agentId }).messages).toEqual([]);
	});

	it('is quiet the second time, because the row is already gone', () => {
		const post = fromOwner('once', { project: slug });
		deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		const again = deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(again.deletedAt).not.toBeNull();
		expect(events).toEqual([]);
	});

	it('refuses a message that never existed', () => {
		expect(refusalCode(() => deleteMessage(h, { messageId: 'nope', by: { kind: 'human' } }))).toBe(
			'not_found'
		);
	});
});

/**
 * Delivery (migration 018): the state between "unread" and "acknowledged".
 *
 * The owner asked for it after watching a message sit there with nothing under
 * it, unable to tell an agent that had it and was busy from an agent that was
 * never told.
 */
describe('marking a message delivered', () => {
	it('records the moment it reached the agent, and says so', () => {
		const post = fromOwner('are you there', { project: slug });

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		const delivered = markMessagesDelivered(h, { agentId, messageIds: [post.id] });

		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ messageId: post.id, agentId });
		expect(events).toEqual([
			expect.objectContaining({
				type: 'message.delivered',
				payload: {
					messageId: post.id,
					agentId,
					projectId,
					updateId: null,
					replyTo: null,
					requestId: null,
					taskId: null
				}
			})
		]);
	});

	it('is quiet the second time, because it is the same fact', () => {
		const post = fromOwner('are you there', { project: slug });
		markMessagesDelivered(h, { agentId, messageIds: [post.id] });

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		const again = markMessagesDelivered(h, { agentId, messageIds: [post.id] });

		expect(again).toEqual([]);
		expect(events).toEqual([]);
		expect(deliveriesFor(h, [post.id])).toHaveLength(1);
	});

	it('does not mark it read: the count stands and the agent still gets it', () => {
		const post = fromOwner('still waiting', { project: slug });

		markMessagesDelivered(h, { agentId, messageIds: [post.id] });

		expect(countUnreadMessages(h, agentId)).toBe(1);
		expect(readMessages(h, { agentId }).messages.map((message) => message.id)).toEqual([post.id]);
	});

	it('delivers nothing for a message that has been deleted', () => {
		const post = fromOwner('never mind', { project: slug });
		deleteMessage(h, { messageId: post.id, by: { kind: 'human' } });

		expect(markMessagesDelivered(h, { agentId, messageIds: [post.id] })).toEqual([]);
		expect(deliveriesFor(h, [post.id])).toEqual([]);
	});

	it('answers what one connection has already been handed', () => {
		const first = fromOwner('one', { project: slug });
		const second = fromOwner('two', { project: slug });
		markMessagesDelivered(h, { agentId, clientId: 'session-a', messageIds: [first.id] });

		const sent = alreadyDelivered(h, agentId, 'session-a', [first.id, second.id]);

		expect([...sent]).toEqual([first.id]);
	});

	it('is per agent, so one agent’s delivery is not another’s', () => {
		const post = fromOwner('anybody', { project: slug });
		const other = h.agent('runner');
		markMessagesDelivered(h, { agentId, clientId: 'session-a', messageIds: [post.id] });

		expect([...alreadyDelivered(h, other, 'session-b', [post.id])]).toEqual([]);
		expect(deliveriesFor(h, [post.id])).toHaveLength(1);
	});

	/**
	 * The regression that took a live session silent (migration 019).
	 *
	 * All of this owner's sessions share one bearer token, so they are one agent
	 * — and "delivered to the agent" meant the first connection handed a message
	 * consumed the only delivery there was. With a dead session's bridge still
	 * holding a socket open, messages were marked delivered and reached nobody.
	 */
	it('tells a second session even when the first has already been told', () => {
		const post = fromOwner('both of you', { project: slug });
		markMessagesDelivered(h, { agentId, clientId: 'session-a', messageIds: [post.id] });

		expect([...alreadyDelivered(h, agentId, 'session-b', [post.id])]).toEqual([]);
		const second = markMessagesDelivered(h, {
			agentId,
			clientId: 'session-b',
			messageIds: [post.id]
		});

		expect(second).toHaveLength(1);
		// Still one line on the card: the owner is told it reached scout, not how
		// many sockets scout had open.
		expect(deliveriesFor(h, [post.id])).toHaveLength(1);
	});

	it('does not tell the same session twice, so a reconnect is quiet', () => {
		const post = fromOwner('once', { project: slug });
		markMessagesDelivered(h, { agentId, clientId: 'session-a', messageIds: [post.id] });

		expect([...alreadyDelivered(h, agentId, 'session-a', [post.id])]).toEqual([post.id]);
		expect(
			markMessagesDelivered(h, { agentId, clientId: 'session-a', messageIds: [post.id] })
		).toEqual([]);
	});

	it('answers nothing for a connection with no name, which remembers its own', () => {
		const post = fromOwner('anonymous', { project: slug });
		markMessagesDelivered(h, { agentId, messageIds: [post.id] });

		// An older bridge has no durable identity, so the database cannot answer
		// for it and it must not be handed somebody else's answer either.
		expect([...alreadyDelivered(h, agentId, null, [post.id])]).toEqual([]);
	});
});

/**
 * The line an answer was aimed at.
 *
 * The owner: "agents need more context from a reply, when I reply to a message,
 * they can not see what I was replying to." An id alone would not have fixed it
 * — `get_messages` hands back the unread set, so the answered line is almost
 * always one the agent has already read and will never be given again.
 */
describe('what a message was answering', () => {
	it('is the line the owner clicked reply on, quoted', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		const asked = postMessage(h, {
			author: { kind: 'agent', agentId },
			updateId: update.id,
			body: 'shall I deploy?'
		});
		const answer = postMessage(h, { author: { kind: 'human' }, answers: asked.id, body: 'yes' });

		expect(answeredMessage(h, answer)).toEqual({
			id: asked.id,
			author: `${AGENT_AUTHOR_PREFIX}${agentId}`,
			body: 'shall I deploy?',
			truncated: false
		});
	});

	it('falls back to the post a reply hangs from, when it answers no one line', () => {
		const post = fromOwner('two things here', { project: slug });
		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'about the first'
		});

		expect(answeredMessage(h, reply)).toMatchObject({ id: post.id, body: 'two things here' });
	});

	it('prefers the comment over the post, because it is the more precise of the two', () => {
		const post = fromOwner('two things here', { project: slug });
		const first = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'about the first'
		});
		const answer = postMessage(h, {
			author: { kind: 'human' },
			answers: first.id,
			body: 'that one'
		});

		// `answers` and `replyTo` are both set on this message (migration 020).
		expect(answer.replyTo).toBe(post.id);
		expect(answeredMessage(h, answer)?.id).toBe(first.id);
	});

	it('is nothing for a message that answers nothing', () => {
		expect(answeredMessage(h, fromOwner('a post of its own', { project: slug }))).toBe(null);
	});

	it('is nothing once the answered line is deleted, rather than a quote of it', () => {
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			project: slug,
			body: 'ignore that, wrong project'
		});
		const answer = postMessage(h, { author: { kind: 'human' }, answers: said.id, body: 'ok' });
		deleteMessage(h, { messageId: said.id, by: { kind: 'agent', agentId } });

		expect(answeredMessage(h, answer)).toBe(null);
	});

	it('trims a long line, and says that it did', () => {
		const long = 'x'.repeat(QUOTED_MAX_LENGTH + 50);
		const said = postMessage(h, { author: { kind: 'agent', agentId }, project: slug, body: long });
		const answer = postMessage(h, { author: { kind: 'human' }, answers: said.id, body: 'ok' });

		const quoted = answeredMessage(h, answer)!;
		expect(quoted.truncated).toBe(true);
		expect(quoted.body).toBe(`${'x'.repeat(QUOTED_MAX_LENGTH)}…`);
	});
});

/**
 * Talking a question over before answering it (migration 032).
 *
 * The owner: "allow me to reply to form questions, so I can discuss with the
 * agent before giving the answer." Until now the buttons were the only thing
 * you could say back, so "why do you want to do that?" meant answering
 * something in order to be able to ask.
 */
describe('a question`s own discussion', () => {
	function question(over: Record<string, unknown> = {}) {
		return createRequest(h, {
			agentId,
			kind: 'form',
			question: 'send this?',
			options: ['Send', 'Cancel'],
			project: slug,
			...over
		}).request;
	}

	it('files a reply under the question, in the question`s project', () => {
		const asked = question();

		const said = postMessage(h, {
			author: { kind: 'human' },
			requestId: asked.id,
			body: 'why that wording?'
		});

		expect(said).toMatchObject({
			requestId: asked.id,
			projectId,
			updateId: null,
			taskId: null,
			replyTo: null
		});
		expect(listThread(h, { requestId: asked.id }).map((m) => m.id)).toEqual([said.id]);
	});

	it('keeps the discussion out of the feed, so it is not a post of its own', () => {
		const asked = question();
		postMessage(h, { author: { kind: 'human' }, requestId: asked.id, body: 'why?' });

		// The feed's posts are messages anchored to nothing; this one is anchored
		// to the question, and belongs under it.
		expect(listThread(h, { project: slug }).filter((m) => m.requestId === null)).toEqual([]);
	});

	it('lets the agent answer in the same discussion, naming the line it answers', () => {
		const asked = question();
		const owner = postMessage(h, {
			author: { kind: 'human' },
			requestId: asked.id,
			body: 'why that wording?'
		});

		const back = postMessage(h, {
			author: { kind: 'agent', agentId },
			answers: owner.id,
			body: 'because the ticket says so'
		});

		// The question supplied the thread: an agent answering need not name it
		// twice, exactly as answering a comment on a card does not.
		expect(back).toMatchObject({ requestId: asked.id, answers: owner.id });
	});

	it('refuses a question that does not exist', () => {
		expect(
			refusalCode(() =>
				postMessage(h, { author: { kind: 'human' }, requestId: 'nope', body: 'hello?' })
			)
		).toBe('not_found');
	});

	it('refuses a line that claims to be on a card as well', () => {
		const asked = question();
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });

		expect(
			refusalCode(() =>
				postMessage(h, {
					author: { kind: 'human' },
					requestId: asked.id,
					updateId: update.id,
					body: 'both?'
				})
			)
		).toBe('invalid_argument');
	});

	it('does not put the discussion in some other question`s thread', () => {
		const first = question();
		const second = question({ question: 'and this?' });
		postMessage(h, { author: { kind: 'human' }, requestId: first.id, body: 'about the first' });

		expect(listThread(h, { requestId: second.id })).toEqual([]);
	});
});

/**
 * Answering one comment inside a thread (migration 020).
 *
 * The owner asked for both halves at once: address a reply to a particular
 * remark, and keep everything in the one thread. So `answers` is a label, and
 * the thread it lands in comes from the comment it answers.
 */
describe('answering a comment', () => {
	it('lands in the same thread as the comment it answers', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			updateId: update.id,
			body: 'the build is green'
		});

		const answer = postMessage(h, {
			author: { kind: 'human' },
			answers: said.id,
			body: 'which suite?'
		});

		expect(answer.updateId).toBe(update.id);
		expect(answer.answers).toBe(said.id);
		expect(listThread(h, { updateId: update.id }).map((m) => m.id)).toEqual([said.id, answer.id]);
	});

	it('works the same under one of the owner’s own posts', () => {
		const post = fromOwner('two things here', { project: slug });
		const first = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'about the first'
		});

		const answer = postMessage(h, {
			author: { kind: 'human' },
			answers: first.id,
			body: 'yes, that one'
		});

		expect(answer.replyTo).toBe(post.id);
		expect(answer.answers).toBe(first.id);
	});

	it('lets a reply answer the post itself, which heads the thread', () => {
		const post = fromOwner('what about this', { project: slug });

		const answer = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			answers: post.id,
			body: 'on it'
		});

		expect(answer.replyTo).toBe(post.id);
		expect(answer.answers).toBe(post.id);
	});

	/**
	 * Found by using it: answering one of the owner's feed posts filed the answer
	 * *beside* the post as a second post of its own, with no project on it — so
	 * it appeared in no feed at all. Naming a post means answering it.
	 */
	it('files an answer to a post underneath that post, keeping its project', () => {
		const post = fromOwner('a question in the feed', { project: slug });

		const answer = postMessage(h, {
			author: { kind: 'agent', agentId },
			answers: post.id,
			body: 'here is the answer'
		});

		expect(answer.replyTo).toBe(post.id);
		expect(answer.projectId).toBe(projectId);
		expect(listThread(h, { project: slug }).map((m) => m.id)).toEqual([post.id, answer.id]);
	});

	it('refuses a comment from a different thread', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		const elsewhere = postMessage(h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'over here'
		});
		const post = fromOwner('a separate conversation', { project: slug });

		expect(
			refusalCode(() =>
				postMessage(h, {
					author: { kind: 'agent', agentId },
					replyTo: post.id,
					answers: elsewhere.id,
					body: 'wrong thread'
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses a comment that has been deleted', () => {
		const post = fromOwner('mind this', { project: slug });
		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'gone in a moment'
		});
		deleteMessage(h, { messageId: reply.id, by: { kind: 'agent', agentId } });

		expect(
			refusalCode(() =>
				postMessage(h, { author: { kind: 'human' }, answers: reply.id, body: 'too late' })
			)
		).toBe('not_found');
	});

	it('leaves an ordinary reply with nothing to answer', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });

		const said = postMessage(h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'nice one'
		});

		expect(said.answers).toBeNull();
	});
});

/**
 * The bug the owner found by using it: "agents post messages, I click the
 * notification, and it doesn't take me to the message, nor can I find it
 * anywhere on the dashboard."
 *
 * They were right, and it was worse than a broken link. The owner replies
 * *inside* a card's thread, so their line carries that card's `updateId`. An
 * agent answering it named it as `replyTo`, and the flattening rule — written
 * for the owner's feed posts, which anchor to nothing — filed the answer with a
 * `replyTo` and no `updateId`. Nothing renders that: a card's thread is read by
 * `updateId`, feed posts are messages with no `replyTo`, and replies are only
 * collected under posts. The message existed, notified, and appeared nowhere.
 */
describe('answering the owner inside a card’s thread', () => {
	it('stays in that thread rather than vanishing out of every one', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		const asked = postMessage(h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'does it handle empty input?'
		});

		const answer = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: asked.id,
			body: 'it does now'
		});

		expect(answer.updateId).toBe(update.id);
		expect(answer.replyTo).toBeNull();
		// Labelled as answering them, which is what a thread renders (migration 020).
		expect(answer.answers).toBe(asked.id);
		expect(listThread(h, { updateId: update.id }).map((m) => m.id)).toEqual([asked.id, answer.id]);
	});

	it('still flattens under one of the owner’s own feed posts', () => {
		const post = fromOwner('a post in the feed', { project: slug });
		const first = postMessage(h, {
			author: { kind: 'agent', agentId },
			replyTo: post.id,
			body: 'on it'
		});

		// Answering that reply files the answer under the post, one level deep,
		// which is what flattening was for.
		const second = postMessage(h, {
			author: { kind: 'human' },
			replyTo: first.id,
			body: 'thanks'
		});

		expect(second.replyTo).toBe(post.id);
		expect(second.updateId).toBeNull();
	});
});

/**
 * Whose inbox is whose (the owner's report).
 *
 * They run two agents — one on a home server, one on a work laptop — and a
 * message they typed in the work project was handed to the Garden Game agent,
 * which answered it: "that isn't me, you've got the wrong agent." It was right,
 * and it should never have been asked.
 *
 * A message belongs to a project, not to an agent, so relevance is derived from
 * what an agent has actually done — the same rule the live stream already kept,
 * now kept by the read and the count as well.
 */
describe('an agent’s inbox is the projects it works in', () => {
	it('does not hand one agent another agent’s conversation', () => {
		const mine = createProject(h, { name: 'Garden Game' }).project;
		const theirs = createProject(h, { name: 'Work' }).project;
		// This agent works in `mine` — an update it posted is what says so.
		postUpdate(h, { project: mine.slug, agentId, body: 'merging' });
		fromOwner('for the work agent', { project: theirs.slug });
		fromOwner('for you', { project: mine.slug });

		const page = readMessages(h, { agentId });

		expect(page.messages.map((message) => message.body)).toEqual(['for you']);
		expect(page.unread).toBe(0);
	});

	it('counts the same way the heartbeat does, so a count is never a dead end', () => {
		const mine = createProject(h, { name: 'Garden Game' }).project;
		const theirs = createProject(h, { name: 'Work' }).project;
		postUpdate(h, { project: mine.slug, agentId, body: 'merging' });
		fromOwner('not yours', { project: theirs.slug });

		// A count that included it would say "something is waiting" for ever: the
		// read would never hand it over, so the agent would fetch and fetch.
		expect(countUnreadMessages(h, agentId)).toBe(0);
	});

	it('still hears everything before it has done anything', () => {
		const somewhere = createProject(h, { name: 'Somewhere' }).project;
		fromOwner('first thing anybody has said to you', { project: somewhere.slug });

		// A brand new agent must not be deaf to the first message ever sent to it.
		expect(readMessages(h, { agentId }).messages.map((m) => m.body)).toEqual([
			'first thing anybody has said to you'
		]);
	});

	it('lets an agent read a project it works in by name', () => {
		const mine = createProject(h, { name: 'Garden Game' }).project;
		postUpdate(h, { project: mine.slug, agentId, body: 'merging' });
		fromOwner('for you', { project: mine.slug });

		expect(readMessages(h, { agentId, project: mine.slug }).messages.map((m) => m.body)).toEqual([
			'for you'
		]);
	});
});

describe('two agents talking through card replies', () => {
	let other: string;
	let updateId: string;

	beforeEach(() => {
		other = h.agent('home-server');
		updateId = postUpdate(h, { project: slug, agentId, body: 'done' }).id;
	});

	function fromAgent(id: string, body: string, scope: Record<string, string> = { updateId }) {
		return postMessage(h, { author: { kind: 'agent', agentId: id }, body, ...scope });
	}

	it('names the agent that wrote a message, and nobody for the owner', () => {
		expect(authorName(h, authorText({ kind: 'agent', agentId: other }))).toBe('home-server');
		expect(authorName(h, HUMAN_AUTHOR)).toBeNull();
	});

	it('lets one agent read what another said on its card', () => {
		fromAgent(other, 'which branch?');

		const page = readMessages(h, { agentId });

		expect(page.messages.map((message) => message.body)).toEqual(['which branch?']);
	});
});

describe('saying which thread a message is in', () => {
	it('names the post a reply hangs off, on every event about the reply', () => {
		const post = fromOwner('what about this', { project: slug });
		h.events.length = 0;

		const reply = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'on it',
			replyTo: post.id
		});

		expect(h.events.at(-1)).toMatchObject({
			type: 'message.created',
			payload: { messageId: reply.id, replyTo: post.id, updateId: null }
		});
	});
});
