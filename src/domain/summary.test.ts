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
			projects: [],
			working: []
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
				agentId,
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

describe('what is being worked on', () => {
	let now: number;
	let t: Harness;
	let rover: string;

	beforeEach(() => {
		now = FIXED_NOW;
		t = harness({ now: () => now });
		rover = t.agent('Rover');
		createProject(t, { name: 'Garden Game', slug: 'garden' });
	});

	const start = (card: { kind: 'update' | 'message'; id: string }, at: number) => {
		now = at;
		setStatus(t, { card, status: 'in_progress' });
	};

	it('is empty when nothing is in progress', () => {
		const update = postUpdate(t, { project: 'garden', agentId: rover, body: 'x' });
		setStatus(t, { card: { kind: 'update', id: update.id }, status: 'todo' });
		expect(ownerSummary(t).working).toEqual([]);
	});

	it('lists in-progress cards in active projects, most recently started first, three at most', () => {
		createProject(t, { name: 'Old', slug: 'old' });
		const ids = ['a', 'b', 'c', 'd'].map(
			(title) => postUpdate(t, { project: 'garden', agentId: rover, title, body: 'x' }).id
		);
		ids.forEach((id, i) => start({ kind: 'update', id }, FIXED_NOW + (i + 1) * 60_000));
		const archived = postUpdate(t, { project: 'old', agentId: rover, title: 'gone', body: 'x' });
		start({ kind: 'update', id: archived.id }, FIXED_NOW + 10 * 60_000);
		updateProject(t, 'old', { status: 'archived' });

		expect(ownerSummary(t).working).toEqual([
			{
				agentId: rover,
				agent: 'Rover',
				task: 'd',
				since: Math.floor((FIXED_NOW + 4 * 60_000) / 1000)
			},
			{
				agentId: rover,
				agent: 'Rover',
				task: 'c',
				since: Math.floor((FIXED_NOW + 3 * 60_000) / 1000)
			},
			{
				agentId: rover,
				agent: 'Rover',
				task: 'b',
				since: Math.floor((FIXED_NOW + 2 * 60_000) / 1000)
			}
		]);
	});

	it('takes an untitled card’s first line as plain text, and cuts a long one', () => {
		const update = postUpdate(t, {
			project: 'garden',
			agentId: rover,
			body: '**Fixing   fee rounding** at `checkout`\n\nThe rest of the report.'
		});
		start({ kind: 'update', id: update.id }, FIXED_NOW);
		const long = postMessage(t, {
			author: { kind: 'agent', agentId: rover },
			body: 'Rewrite the whole onboarding flow so that new players never see an empty garden on day one',
			project: 'garden'
		});
		start({ kind: 'message', id: long.id }, FIXED_NOW + 1000);

		const [message, card] = ownerSummary(t).working;
		expect(card.task).toBe('Fixing fee rounding at checkout');
		expect(message.agentId).toBe(rover);
		expect(message.task).toHaveLength(60);
		expect(message.task).toBe('Rewrite the whole onboarding flow so that new players never…');
	});

	it('names the agent answering an owner’s card, or nobody', () => {
		const asked = postMessage(t, {
			author: { kind: 'human' },
			body: 'Find out why the Mac build is slow',
			project: 'garden'
		});
		start({ kind: 'message', id: asked.id }, FIXED_NOW);
		const alone = postMessage(t, {
			author: { kind: 'human' },
			body: 'Tidy the docs',
			project: 'garden'
		});
		start({ kind: 'message', id: alone.id }, FIXED_NOW - 1000);
		const scout = t.agent('Scout');
		postMessage(t, { author: { kind: 'agent', agentId: rover }, body: 'on it', replyTo: asked.id });
		now += 1;
		postMessage(t, {
			author: { kind: 'agent', agentId: scout },
			body: 'me too',
			replyTo: asked.id
		});

		expect(ownerSummary(t).working).toEqual([
			{
				agentId: scout,
				agent: 'Scout',
				task: 'Find out why the Mac build is slow',
				since: Math.floor(FIXED_NOW / 1000)
			},
			{
				agentId: null,
				agent: 'An agent',
				task: 'Tidy the docs',
				since: Math.floor((FIXED_NOW - 1000) / 1000)
			}
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
			topKind: 'confirm',
			topAgentId: agentId,
			topProject: null,
			topExpiresAt: Math.floor(first.expiresAt / 1000),
			topOptions: null,
			topDefault: null,
			working: null
		});
	});

	it('keeps the seven old keys first and appends the new ones in order', () => {
		expect(Object.keys(liveActivityState(ownerSummary(h)))).toEqual([
			'online',
			'waiting',
			'inProgress',
			'topAgent',
			'topQuestion',
			'topRequestId',
			'topKind',
			'topAgentId',
			'topProject',
			'topExpiresAt',
			'topOptions',
			'topDefault',
			'working'
		]);
	});

	it('carries the top request’s project, options and default for the lock screen', () => {
		createProject(h, { name: 'Garden Game: the long-running seasonal edition', slug: 'garden' });
		createRequest(h, {
			agentId,
			kind: 'choice',
			question: 'which?',
			options: ['Ship it', 'Wait'],
			default: 'Wait',
			project: 'garden'
		});

		expect(liveActivityState(ownerSummary(h))).toMatchObject({
			topProject: 'Garden Game: the long-running seasonal…',
			topOptions: ['Ship it', 'Wait'],
			topDefault: 'Wait'
		});
	});

	it('sends no options it would have to cut or that do not fit', () => {
		const state = (options: string[], kind: 'buttons' | 'multi_choice' = 'buttons') => {
			const t = harness();
			createRequest(t, { agentId: t.agent('a'), kind, question: 'q', options });
			return liveActivityState(ownerSummary(t)).topOptions;
		};
		expect(state(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
		expect(state(['a', 'b', 'c', 'd', 'e'])).toBeNull();
		expect(state(['short', 'x'.repeat(41)])).toBeNull();
		expect(state(['a', 'b'], 'multi_choice')).toBeNull();
	});

	it('drops a default too long to show', () => {
		createRequest(h, { agentId, kind: 'text', question: 'note?', default: 'y'.repeat(41) });
		expect(liveActivityState(ownerSummary(h)).topDefault).toBeNull();
	});

	it('shows what is being worked on', () => {
		createProject(h, { name: 'Garden', slug: 'garden' });
		const update = postUpdate(h, { project: 'garden', agentId, title: 'Fees', body: 'x' });
		setStatus(h, { card: { kind: 'update', id: update.id }, status: 'in_progress' });

		expect(liveActivityState(ownerSummary(h)).working).toEqual([
			{ agentId, agent: 'scout', task: 'Fees', since: Math.floor(FIXED_NOW / 1000) }
		]);
	});

	it('has no top when nothing is waiting', () => {
		expect(liveActivityState(ownerSummary(h))).toEqual({
			online: 0,
			waiting: 0,
			inProgress: 0,
			topAgent: null,
			topQuestion: null,
			topRequestId: null,
			topKind: null,
			topAgentId: null,
			topProject: null,
			topExpiresAt: null,
			topOptions: null,
			topDefault: null,
			working: null
		});
	});
});
