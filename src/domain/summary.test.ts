import { beforeEach, describe, expect, it } from 'vitest';
import { setStatus } from './cards';
import { postMessage } from './messages';
import { createProject, updateProject } from './projects';
import { createRequest } from './requests';
import { registerSession } from './sessions';
import { liveActivityState, ownerSummary } from './summary';
import { FIXED_NOW, harness, type Harness } from './testing';
import { postUpdate } from './updates';

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
});

describe('the owner summary', () => {
	it('is empty on a fresh deployment', () => {
		expect(ownerSummary(h)).toEqual({
			at: new Date(FIXED_NOW).toISOString(),
			onlineAgents: [],
			requests: [],
			work: { todo: 0, inProgress: 0, blocked: 0 },
			projects: []
		});
	});

	it('lists who is online', () => {
		registerSession(h, { agentId, meta: { host: 'laptop', cwd: '/src' } });

		expect(ownerSummary(h).onlineAgents).toEqual([
			{ agentId, name: 'scout', host: 'laptop', cwd: '/src' }
		]);
	});

	it('lists pending requests oldest first, with their project', () => {
		createProject(h, { name: 'Fees', slug: 'fees' });
		const first = createRequest(h, {
			agentId,
			kind: 'choice',
			question: 'which?',
			detail: 'a is faster, b is safer',
			options: ['a', 'b'],
			default: 'b',
			project: 'fees'
		}).request;
		const second = createRequest(h, { agentId, kind: 'confirm', question: 'ship?' }).request;

		expect(ownerSummary(h).requests).toEqual([
			{
				id: first.id,
				agentName: 'scout',
				projectSlug: 'fees',
				projectName: 'Fees',
				question: 'which?',
				detail: 'a is faster, b is safer',
				default: 'b',
				kind: 'choice',
				options: ['a', 'b'],
				expiresAt: new Date(first.expiresAt).toISOString()
			},
			expect.objectContaining({
				id: second.id,
				kind: 'confirm',
				options: null,
				projectSlug: null,
				detail: null,
				default: null
			})
		]);
	});

	it('counts open work in active projects only', () => {
		createProject(h, { name: 'Live', slug: 'live' });
		createProject(h, { name: 'Old', slug: 'old' });
		const mark = (project: string, status: 'todo' | 'in_progress' | 'blocked' | 'done') => {
			const update = postUpdate(h, { project, agentId, body: 'work' });
			setStatus(h, { card: { kind: 'update', id: update.id }, status });
		};
		mark('live', 'todo');
		mark('live', 'todo');
		mark('live', 'in_progress');
		mark('live', 'blocked');
		mark('live', 'done');
		mark('old', 'todo');
		const message = postMessage(h, { author: { kind: 'human' }, body: 'do it', project: 'live' });
		setStatus(h, { card: { kind: 'message', id: message.id }, status: 'todo' });
		updateProject(h, 'old', { status: 'archived' });

		expect(ownerSummary(h).work).toEqual({ todo: 3, inProgress: 1, blocked: 1 });
	});

	it('lists active projects pinned first, then by name', () => {
		createProject(h, { name: 'Zeta', slug: 'zeta' });
		createProject(h, { name: 'alpha', slug: 'alpha' });
		createProject(h, { name: 'Mid', slug: 'mid' });
		createProject(h, { name: 'Gone', slug: 'gone' });
		updateProject(h, 'zeta', { pinned: true });
		updateProject(h, 'gone', { status: 'archived' });

		expect(ownerSummary(h).projects).toEqual([
			{ slug: 'zeta', name: 'Zeta' },
			{ slug: 'alpha', name: 'alpha' },
			{ slug: 'mid', name: 'Mid' }
		]);
	});
});

describe('the Live Activity state', () => {
	it('puts the longest-waiting request on top', () => {
		registerSession(h, { agentId });
		const first = createRequest(h, { agentId, kind: 'confirm', question: 'first?' }).request;
		createRequest(h, { agentId, kind: 'confirm', question: 'second?' });

		expect(liveActivityState(ownerSummary(h))).toEqual({
			online: 1,
			waiting: 2,
			inProgress: 0,
			topAgent: 'scout',
			topQuestion: 'first?',
			topRequestId: first.id,
			topKind: 'confirm'
		});
	});

	it('has no top when nothing is waiting', () => {
		expect(liveActivityState(ownerSummary(h))).toEqual({
			online: 0,
			waiting: 0,
			inProgress: 0,
			topAgent: null,
			topQuestion: null,
			topRequestId: null,
			topKind: null
		});
	});
});
