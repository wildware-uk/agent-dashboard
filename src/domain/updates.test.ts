import { beforeEach, describe, expect, it } from 'vitest';
import { insertSession } from '$db';
import { createProject } from './projects';
import { deleteUpdate, listUpdates, postUpdate } from './updates';
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
