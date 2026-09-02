import { beforeEach, describe, expect, it } from 'vitest';
import { findMessageById, insertTask, readCursorSeq } from '$db';
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
	postMessage,
	readMessages
} from './messages';
import { createProject } from './projects';
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

	it('scopes one to a task, and derives the project from it', () => {
		const task = insertTask(h.db, { projectId, title: 'ship', body: 'the thing' });

		const message = fromOwner('start with the tests', { taskId: task.id });

		expect(message).toMatchObject({ taskId: task.id, projectId });
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
			author: HUMAN_AUTHOR
		});
	});

	it('refuses a blank body, an over-long one, and an unknown scope', () => {
		expect(refusalCode(() => fromOwner('   ', { project: slug }))).toBe('invalid_argument');
		expect(refusalCode(() => fromOwner('x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1)))).toBe(
			'invalid_argument'
		);
		expect(refusalCode(() => fromOwner('hi', { updateId: 'nope' }))).toBe('not_found');
		expect(refusalCode(() => fromOwner('hi', { taskId: 'nope' }))).toBe('not_found');
		expect(refusalCode(() => fromOwner('hi', { project: 'nope' }))).toBe('not_found');
	});

	it('refuses an agent that does not exist, so a message cannot be attributed to nobody', () => {
		expect(
			refusalCode(() => postMessage(h, { author: { kind: 'agent', agentId: 'ghost' }, body: 'hi' }))
		).toBe('not_found');
	});

	it('refuses to hang one message off both an update and a task', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'done' });
		const task = insertTask(h.db, { projectId, title: 'ship', body: 'it' });

		expect(refusalCode(() => fromOwner('hi', { updateId: update.id, taskId: task.id }))).toBe(
			'invalid_argument'
		);
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
		expect(readCursorSeq(h.db, agentId)).toBe(0);
		// The same messages come back, because nothing was read.
		expect(readMessages(h, { agentId, markRead: false }).messages).toHaveLength(1);

		const read = readMessages(h, { agentId });
		expect(read.markedRead).toBe(true);
		expect(readCursorSeq(h.db, agentId)).toBe(read.messages.at(-1)!.seq);
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
		// A cursor is one integer per reader (design §3), so it stops short of the
		// message this read stepped over rather than jumping it. Both are therefore
		// still unread, and both come back: a filtered read can re-deliver, which is
		// the tradeoff that makes it impossible for it to *lose* a message.
		expect(scoped.unread).toBe(2);
		expect(readMessages(h, { agentId }).messages.map((message) => message.body)).toEqual([
			'for other',
			'for dashboard'
		]);
		// And once the cursor has passed both, nothing comes back again.
		expect(readMessages(h, { agentId }).messages).toEqual([]);
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
