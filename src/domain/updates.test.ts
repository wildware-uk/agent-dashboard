import { beforeEach, describe, expect, it } from 'vitest';
import { insertSession } from '$db';
import { createProject } from './projects';
import { createTask } from './tasks';
import {
	deleteUpdate,
	editUpdate,
	listUpdates,
	markRepliesSeen,
	postUpdate,
	setUpdatePinned
} from './updates';
import { FIXED_NOW, harness, type Harness } from './testing';

let h: Harness;
let agentId: string;
let projectId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent();
	projectId = createProject(h, { name: 'Agent Dashboard' }).project.id;
	h.events.length = 0;
});

describe('postUpdate', () => {
	it('stores the update with the documented defaults', () => {
		const update = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' });

		expect(update).toMatchObject({
			projectId,
			agentId,
			sessionId: null,
			title: null,
			body: 'shipped it',
			level: 'info',
			pinned: false,
			createdAt: FIXED_NOW,
			deletedAt: null
		});
		expect(update.id).toHaveLength(26);
	});

	it('takes a project id just as happily as a slug', () => {
		expect(postUpdate(h, { project: projectId, agentId, body: 'x' }).projectId).toBe(projectId);
	});

	it('keeps the title, level and session it is given', () => {
		const sessionId = insertSession(h.db, { agentId }).id;

		const update = postUpdate(h, {
			project: 'agent-dashboard',
			agentId,
			body: '# done',
			title: '  Shipped  ',
			level: 'success',
			sessionId
		});

		expect(update).toMatchObject({ title: 'Shipped', level: 'success', sessionId });
	});

	it('publishes exactly one update.created', () => {
		const update = postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' });

		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'update.created',
			payload: { updateId: update.id, projectId, agentId }
		});
	});

	it('refuses an empty body, an unknown project and an unknown agent, writing nothing', () => {
		expect(() => postUpdate(h, { project: 'agent-dashboard', agentId, body: ' ' })).toThrow(
			/body is required/
		);
		expect(() => postUpdate(h, { project: 'nope', agentId, body: 'x' })).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId: 'ghost', body: 'x' })
		).toThrow(/agent/);
		expect(listUpdates(h).updates).toEqual([]);
		expect(h.events).toEqual([]);
	});

	it('refuses a session that is not this agent’s, so no agent can post as another', () => {
		const otherId = h.agent('other');
		const theirSession = insertSession(h.db, { agentId: otherId }).id;

		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'x', sessionId: theirSession })
		).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'x', sessionId: 'ghost' })
		).toThrowError(expect.objectContaining({ code: 'not_found' }));
	});

	it('rejects an over-long body and title rather than truncating an agent’s work', () => {
		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'a'.repeat(100_001) })
		).toThrow(/body must be at most/);
		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'x', title: 'a'.repeat(201) })
		).toThrow(/title must be at most/);
	});
});

describe('listUpdates', () => {
	function post(body: string) {
		return postUpdate(h, { project: 'agent-dashboard', agentId, body });
	}

	it('returns the timeline newest first with no cursor when it fits', () => {
		post('one');
		const second = post('two');

		const page = listUpdates(h);

		expect(page.updates.map((u) => u.body)).toEqual(['two', 'one']);
		expect(page).toMatchObject({ hasMore: false, nextCursor: null });
		expect(page.updates[0].id).toBe(second.id);
	});

	it('pages by seq, and the page is stable when new updates arrive mid-scroll', () => {
		const posted = ['1', '2', '3', '4', '5'].map(post);

		const first = listUpdates(h, { limit: 2 });
		// The agent keeps working while the owner reads.
		post('6');
		post('7');
		const second = listUpdates(h, { limit: 2, cursor: first.nextCursor });
		const third = listUpdates(h, { limit: 2, cursor: second.nextCursor });

		expect(first.updates.map((u) => u.body)).toEqual(['5', '4']);
		expect(first.hasMore).toBe(true);
		expect(second.updates.map((u) => u.body)).toEqual(['3', '2']);
		expect(third.updates.map((u) => u.body)).toEqual(['1']);
		expect(third).toMatchObject({ hasMore: false, nextCursor: null });
		expect([...first.updates, ...second.updates, ...third.updates].map((u) => u.id)).toEqual(
			posted.map((u) => u.id).reverse()
		);
	});

	it('filters by project and by agent', () => {
		createProject(h, { name: 'Other' });
		const otherAgent = h.agent('other');
		post('mine');
		postUpdate(h, { project: 'other', agentId: otherAgent, body: 'theirs' });

		expect(listUpdates(h, { project: 'other' }).updates.map((u) => u.body)).toEqual(['theirs']);
		expect(listUpdates(h, { agentId }).updates.map((u) => u.body)).toEqual(['mine']);
		expect(listUpdates(h).updates).toHaveLength(2);
	});

	it('hides soft-deleted updates unless asked for them', () => {
		post('kept');
		const gone = post('gone');
		deleteUpdate(h, gone.id);

		expect(listUpdates(h).updates.map((u) => u.body)).toEqual(['kept']);
		expect(listUpdates(h, { includeDeleted: true }).updates.map((u) => u.body)).toEqual([
			'gone',
			'kept'
		]);
	});

	it('resolves the project reference, and reports not_found for a stranger', () => {
		post('mine');

		expect(listUpdates(h, { project: projectId }).updates).toHaveLength(1);
		expect(() => listUpdates(h, { project: 'nope' })).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
	});

	it('caps and validates the limit and the cursor', () => {
		post('one');

		expect(listUpdates(h, { limit: 10_000 }).updates).toHaveLength(1);
		expect(() => listUpdates(h, { limit: 0 })).toThrow(/limit/);
		expect(() => listUpdates(h, { limit: 1.5 })).toThrow(/limit/);
		expect(() => listUpdates(h, { cursor: 'abc' })).toThrow(/cursor/);
	});

	it('treats a null cursor as the first page', () => {
		post('one');

		expect(listUpdates(h, { cursor: null }).updates).toHaveLength(1);
	});

	it('reads nothing but publishes nothing either', () => {
		post('one');
		h.events.length = 0;

		listUpdates(h);

		expect(h.events).toEqual([]);
	});
});

describe('deleteUpdate', () => {
	function post() {
		return postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' });
	}

	it('sets deleted_at, leaves the row in place, and publishes update.deleted', () => {
		const update = post();
		h.events.length = 0;

		const deleted = deleteUpdate(h, update.id);

		expect(deleted).toMatchObject({ id: update.id, body: 'shipped it', deletedAt: FIXED_NOW });
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'update.deleted',
			payload: { updateId: update.id, projectId }
		});
		expect(listUpdates(h, { includeDeleted: true }).updates.map((u) => u.id)).toEqual([update.id]);
	});

	it('is idempotent: a second delete returns the row and publishes nothing new', () => {
		const update = post();
		deleteUpdate(h, update.id);
		h.events.length = 0;

		expect(deleteUpdate(h, update.id).deletedAt).toBe(FIXED_NOW);
		expect(h.events).toEqual([]);
	});

	it('reports not_found for an update that never existed', () => {
		expect(() => deleteUpdate(h, 'ghost')).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
	});
});

describe('setUpdatePinned', () => {
	function post() {
		return postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it' });
	}

	it('pins the update and publishes update.updated', () => {
		const update = post();
		h.events.length = 0;

		const pinned = setUpdatePinned(h, update.id, true);

		expect(pinned).toMatchObject({ id: update.id, pinned: true });
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'update.updated',
			payload: { updateId: update.id, projectId, pinned: true }
		});
	});

	it('unpins again, and the row the timeline reads agrees', () => {
		const update = post();
		setUpdatePinned(h, update.id, true);
		h.events.length = 0;

		expect(setUpdatePinned(h, update.id, false).pinned).toBe(false);
		expect(listUpdates(h).updates[0].pinned).toBe(false);
		expect(h.eventNames()).toEqual(['update.updated']);
	});

	it('publishes nothing when the flag already says what was asked for', () => {
		const update = post();
		setUpdatePinned(h, update.id, true);
		h.events.length = 0;

		expect(setUpdatePinned(h, update.id, true).pinned).toBe(true);
		expect(h.events).toEqual([]);
	});

	it('refuses to pin an update that has been deleted', () => {
		const update = post();
		deleteUpdate(h, update.id);
		h.events.length = 0;

		expect(() => setUpdatePinned(h, update.id, true)).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
		expect(h.events).toEqual([]);
	});

	it('reports not_found for an update that never existed', () => {
		expect(() => setUpdatePinned(h, 'ghost', true)).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
	});
});

/**
 * An agent correcting its own card (design §3, §5).
 *
 * The rule worth the most tests here is the one that protects the wall: an agent
 * may only edit what it posted, because a shared timeline whose entries can be
 * rewritten by anyone is not a record of anything.
 */
describe('editUpdate', () => {
	const post = (over: Record<string, unknown> = {}) =>
		postUpdate(h, { project: 'agent-dashboard', agentId, body: 'deploying', ...over });

	it('replaces the body and stamps when', () => {
		const posted = post();

		const edited = editUpdate(h, { updateId: posted.id, agentId, body: 'deployed' });

		expect(edited).toMatchObject({ body: 'deployed', editedAt: FIXED_NOW });
	});

	it('leaves every field the edit did not name', () => {
		const posted = post({ title: 'release 1.2', level: 'warn' });

		const edited = editUpdate(h, { updateId: posted.id, agentId, body: 'deployed' });

		expect(edited).toMatchObject({ title: 'release 1.2', level: 'warn' });
	});

	it('corrects the level, which is the whole point of editing a warning', () => {
		const posted = post({ level: 'warn' });

		expect(editUpdate(h, { updateId: posted.id, agentId, level: 'success' }).level).toBe('success');
	});

	it('clears a headline when the edit says null', () => {
		const posted = post({ title: 'release 1.2' });

		expect(editUpdate(h, { updateId: posted.id, agentId, title: null }).title).toBeNull();
	});

	it('does not move the card in the timeline', () => {
		const posted = post();

		const edited = editUpdate(h, { updateId: posted.id, agentId, body: 'deployed' });

		expect(edited.createdAt).toBe(posted.createdAt);
		expect(edited.seq).toBe(posted.seq);
	});

	it('leaves the owner’s pin alone', () => {
		const posted = post();
		setUpdatePinned(h, posted.id, true);

		expect(editUpdate(h, { updateId: posted.id, agentId, body: 'deployed' }).pinned).toBe(true);
	});

	it('publishes once, so every open tab refetches the row', () => {
		const posted = post();
		h.events.length = 0;

		editUpdate(h, { updateId: posted.id, agentId, body: 'deployed' });

		expect(h.eventNames()).toEqual(['update.updated']);
		expect(h.events[0].payload).toMatchObject({ updateId: posted.id, projectId });
	});

	it('refuses another agent’s update rather than ignoring the attempt', () => {
		const posted = post();
		const other = h.agent('nova');

		expect(() => editUpdate(h, { updateId: posted.id, agentId: other, body: 'mine now' })).toThrow(
			/another agent/
		);
		expect(listUpdates(h, {}).updates[0].body).toBe('deploying');
	});

	it('refuses a deleted update rather than resurrecting its text', () => {
		const posted = post();
		deleteUpdate(h, posted.id);

		expect(() => editUpdate(h, { updateId: posted.id, agentId, body: 'back' })).toThrow(
			/no such update/
		);
	});

	it('refuses an update that does not exist', () => {
		expect(() => editUpdate(h, { updateId: 'nope', agentId, body: 'x' })).toThrow(/no such update/);
	});

	it('refuses an edit that names no field, which is a caller bug', () => {
		const posted = post();

		expect(() => editUpdate(h, { updateId: posted.id, agentId })).toThrow(/must change/);
	});

	it('refuses an empty body, the same as posting one', () => {
		const posted = post();

		expect(() => editUpdate(h, { updateId: posted.id, agentId, body: '   ' })).toThrow(/body/);
	});

	it('refuses a level the card could not colour', () => {
		const posted = post();

		expect(() =>
			editUpdate(h, { updateId: posted.id, agentId, level: 'critical' as never })
		).toThrow(/level must be/);
	});

	it('is never quiet: an edit that changes nothing is still stamped', () => {
		const posted = post();

		expect(editUpdate(h, { updateId: posted.id, agentId, body: 'deploying' }).editedAt).toBe(
			FIXED_NOW
		);
	});
});

/**
 * Filing an update against a task (design §7).
 *
 * The feed answers "what happened"; a task answers "what is being worked on".
 * This is the join between them, and the rule that matters is that it cannot
 * cross a project — the task page and the project timeline would then disagree
 * about where the work belongs.
 */
describe('updates on a task', () => {
	it('files an update against a task in the same project', () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'Ship it' });

		const update = postUpdate(h, {
			project: 'agent-dashboard',
			agentId,
			body: 'step 3 of 7',
			taskId: task.id
		});

		expect(update.taskId).toBe(task.id);
	});

	it('is null for the ordinary update, which is most of them', () => {
		expect(
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'a note' }).taskId
		).toBeNull();
	});

	it('refuses a task that does not exist', () => {
		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'x', taskId: 'nope' })
		).toThrow(/no such task/);
	});

	it('refuses a task from another project rather than filing it anyway', () => {
		const other = createProject(h, { name: 'Other' }).project;
		const task = createTask(h, { project: other.slug, title: 'Elsewhere' });

		expect(() =>
			postUpdate(h, { project: 'agent-dashboard', agentId, body: 'x', taskId: task.id })
		).toThrow(/another project/);
	});

	it('lists a task’s own updates, newest first', () => {
		const task = createTask(h, { project: 'agent-dashboard', title: 'Ship it' });
		postUpdate(h, { project: 'agent-dashboard', agentId, body: 'first', taskId: task.id });
		postUpdate(h, { project: 'agent-dashboard', agentId, body: 'second', taskId: task.id });
		postUpdate(h, { project: 'agent-dashboard', agentId, body: 'unrelated' });

		const listed = listUpdates(h, { taskId: task.id }).updates;

		expect(listed.map((update) => update.body)).toEqual(['second', 'first']);
	});
});

/**
 * Marking a card's conversation read (migration 015).
 *
 * "Recent replies" lifts a card out of its day while a conversation is live on
 * it. Without this it only ever grew, and the cards riding above the timeline
 * became the ones the owner had been ignoring the longest.
 */
describe('markRepliesSeen', () => {
	function post() {
		return postUpdate(h, { project: projectId, agentId, body: 'shipped it' });
	}

	it('stamps when the owner read the thread', () => {
		const update = post();

		expect(markRepliesSeen(h, update.id).repliesSeenAt).toBe(FIXED_NOW);
	});

	it('starts unread, which is what keeps a fresh conversation at the top', () => {
		expect(post().repliesSeenAt).toBeNull();
	});

	it('tells every open tab, so the section clears on both screens', () => {
		const update = post();
		h.events.length = 0;

		markRepliesSeen(h, update.id);

		expect(h.eventNames()).toContain('update.updated');
	});

	it('does not mark the card edited: reading a thread is not editing it', () => {
		const update = post();

		expect(markRepliesSeen(h, update.id).editedAt).toBeNull();
	});

	it('is safe to send twice', () => {
		const update = post();
		markRepliesSeen(h, update.id);

		expect(markRepliesSeen(h, update.id).repliesSeenAt).toBe(FIXED_NOW);
	});

	it('refuses an update that is not there, or has been deleted', () => {
		const update = post();
		deleteUpdate(h, update.id);

		expect(() => markRepliesSeen(h, update.id)).toThrow();
		expect(() => markRepliesSeen(h, 'nope')).toThrow();
	});
});
