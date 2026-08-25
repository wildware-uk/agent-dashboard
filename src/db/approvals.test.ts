import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertProject } from './projects';
import {
	decideApproval,
	expireApprovals,
	findApprovalById,
	insertApproval,
	listApprovals
} from './approvals';

let db: Db;
let agentId: string;
let projectId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
	projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
});

const ask = (over: Partial<Parameters<typeof insertApproval>[1]> = {}) =>
	insertApproval(db, {
		agentId,
		question: 'ship it?',
		expiresAt: 10_000,
		...over
	});

describe('insertApproval', () => {
	it('starts pending, with the options the agent offered', () => {
		const approval = ask({ projectId, options: ['ship', 'wait'] });

		expect(approval).toMatchObject({
			agentId,
			projectId,
			updateId: null,
			question: 'ship it?',
			options: ['ship', 'wait'],
			state: 'pending',
			expiresAt: 10_000,
			decidedAt: null,
			decidedValue: null
		});
	});

	it('round-trips a question with no options at all', () => {
		const approval = ask();

		expect(findApprovalById(db, approval.id)).toMatchObject({ options: null });
	});
});

describe('decideApproval', () => {
	it('records the decision and its value', () => {
		const approval = ask({ options: ['ship', 'wait'] });

		const decided = decideApproval(db, approval.id, {
			state: 'approved',
			value: 'ship',
			at: 500
		});

		expect(decided).toMatchObject({
			state: 'approved',
			decidedValue: 'ship',
			decidedAt: 500
		});
	});

	it('decides once: a second decision cannot overwrite the first', () => {
		const approval = ask();
		decideApproval(db, approval.id, { state: 'approved', at: 500 });

		expect(decideApproval(db, approval.id, { state: 'rejected', at: 600 })).toBeUndefined();
		expect(findApprovalById(db, approval.id)).toMatchObject({ state: 'approved' });
	});

	it('is also how the UI cancels a waiting agent', () => {
		const approval = ask();

		expect(decideApproval(db, approval.id, { state: 'cancelled', at: 500 })).toMatchObject({
			state: 'cancelled'
		});
	});

	it('reports nothing for an unknown approval', () => {
		expect(decideApproval(db, 'nope', { state: 'approved' })).toBeUndefined();
	});
});

describe('expireApprovals', () => {
	it('flips pending approvals past their expiry to timeout, and returns them', () => {
		const stale = ask({ expiresAt: 100 });
		const live = ask({ expiresAt: 9000 });
		const decided = ask({ expiresAt: 100 });
		decideApproval(db, decided.id, { state: 'approved', at: 50 });

		const expired = expireApprovals(db, { now: 1000 });

		expect(expired.map((a) => a.id)).toEqual([stale.id]);
		expect(findApprovalById(db, stale.id)).toMatchObject({ state: 'timeout', decidedAt: 1000 });
		expect(findApprovalById(db, live.id)).toMatchObject({ state: 'pending' });
		expect(findApprovalById(db, decided.id)).toMatchObject({ state: 'approved' });
	});

	it('finds nothing to do on a second pass', () => {
		ask({ expiresAt: 100 });
		expireApprovals(db, { now: 1000 });

		expect(expireApprovals(db, { now: 2000 })).toEqual([]);
	});
});

describe('listApprovals', () => {
	it('filters by state and agent, newest first — the banner`s query', () => {
		const other = insertAgent(db, { name: 'other', tokenHash: 'h2' }).id;
		const first = ask();
		const second = ask({ agentId: other });
		const done = ask();
		decideApproval(db, done.id, { state: 'approved', at: 1 });

		expect(listApprovals(db, { state: 'pending' }).map((a) => a.id)).toEqual([second.id, first.id]);
		expect(listApprovals(db, { agentId: other }).map((a) => a.id)).toEqual([second.id]);
		expect(listApprovals(db, { state: 'pending', agentId }).map((a) => a.id)).toEqual([first.id]);
	});
});
