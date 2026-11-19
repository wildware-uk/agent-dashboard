import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findMediaById, insertApproval, insertMedia, type Db } from '$db';
import { EventBus } from '$events';
import { context, type DomainContext } from './context';
import { createProject } from './projects';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import { harness, FIXED_NOW, type Harness } from './testing';
import {
	DEFAULT_HOLD_MS,
	POLL_AFTER_MS,
	answerRequest,
	awaitRequest,
	cancelRequest,
	editRequest,
	withdrawRequest,
	countPendingRequests,
	createRequest,
	expireRequests,
	findRequest,
	listPendingRequests,
	requestInput,
	startRequestSweeper,
	validateAnswer,
	type CreateRequestInput,
	type OwnerRequest
} from './requests';

/**
 * A clock the test moves, because expiry is a rule about time.
 *
 * The default harness clock is frozen, which is right for asserting a stored
 * timestamp and wrong for asserting that a deadline passed.
 */
let clock = FIXED_NOW;
let h: Harness;
let agentId: string;

beforeEach(() => {
	vi.useFakeTimers();
	clock = FIXED_NOW;
	h = harness({ now: () => clock });
	agentId = h.agent('claude');
});

afterEach(() => {
	vi.useRealTimers();
});

/** Move the clock and the timers together, as real time does. */
async function elapse(ms: number) {
	clock += ms;
	await vi.advanceTimersByTimeAsync(ms);
}

const ask = (over: Partial<CreateRequestInput> = {}) =>
	createRequest(h, { agentId, kind: 'confirm', question: 'ship it?', ...over }).request;

describe('asking (design §5)', () => {
	it('writes a pending row and announces it, for each of the five kinds', () => {
		const asks: CreateRequestInput[] = [
			{ agentId, kind: 'text', question: 'commit message?' },
			{ agentId, kind: 'confirm', question: 'push to main?' },
			{ agentId, kind: 'buttons', question: 'the build failed', options: ['retry', 'skip'] },
			{ agentId, kind: 'choice', question: 'which branch?', options: ['main', 'next'] },
			{ agentId, kind: 'multi_choice', question: 'delete which?', options: ['a', 'b'] }
		];

		for (const input of asks) {
			const { request } = createRequest(h, input);

			expect(request, input.kind).toMatchObject({
				kind: input.kind,
				state: 'pending',
				agentId,
				answer: null,
				answeredAt: null
			});
		}

		expect(h.eventNames()).toEqual(Array(5).fill('request.created'));
		expect(h.events[0].payload).toMatchObject({ kind: 'text', agentId });
	});

	it('defaults the deadline to an hour, and honours timeout_s', () => {
		expect(ask().expiresAt).toBe(FIXED_NOW + 3_600_000);
		expect(ask({ timeoutS: 60 }).expiresAt).toBe(FIXED_NOW + 60_000);
	});

	it('keeps the knobs each kind understands', () => {
		const text = ask({
			kind: 'text',
			question: 'commit message?',
			placeholder: 'fix: …',
			multiline: true,
			default: 'fix: the thing',
			max: 200
		});
		const many = ask({
			kind: 'multi_choice',
			question: 'which?',
			options: ['a', 'b', 'c'],
			min: 1,
			max: 2
		});

		expect(text.config).toEqual({
			placeholder: 'fix: …',
			multiline: true,
			default: 'fix: the thing',
			max: 200
		});
		expect(many.config).toEqual({ min: 1, max: 2 });
	});

	it('anchors to a project, and to an update whose project it takes', () => {
		const project = createProject(h, { name: 'Dash' }).project;
		const update = postUpdate(h, { project: project.slug, agentId, body: 'done' });

		expect(ask({ project: project.slug }).projectId).toBe(project.id);
		expect(ask({ update: update.id })).toMatchObject({
			projectId: project.id,
			updateId: update.id
		});
	});

	it('refuses a request that contradicts itself', () => {
		const bad: [string, Partial<CreateRequestInput>][] = [
			['a choice with no options', { kind: 'choice' }],
			['a confirm with options', { kind: 'confirm', options: ['yes'] }],
			['duplicate options', { kind: 'buttons', options: ['a', 'a'] }],
			['a blank question', { question: '   ' }],
			['a placeholder on a confirm', { placeholder: 'hint' }],
			['min above max', { kind: 'multi_choice', options: ['a', 'b'], min: 2, max: 1 }],
			['a max beyond the options', { kind: 'multi_choice', options: ['a'], max: 5 }],
			['a default that is not an option', { kind: 'choice', options: ['a'], default: 'z' }],
			['an unknown kind', { kind: 'freeform' as never }],
			['a timeout under the floor', { timeoutS: 1 }],
			['a project that does not exist', { project: 'nope' }]
		];

		for (const [why, input] of bad) {
			expect(() => ask(input), why).toThrow(
				expect.objectContaining({ code: expect.stringMatching(/invalid_argument|not_found/) })
			);
		}
	});
});

describe('the bounded long-poll (design §5)', () => {
	it('returns immediately when the owner answers during the hold', async () => {
		const wait = requestInput(h, { agentId, kind: 'text', question: 'commit message?' });
		await vi.advanceTimersByTimeAsync(0);
		const pending = listPendingRequests(h)[0];

		answerRequest(h, { requestId: pending.id, value: 'fix: the parser' });

		await expect(wait).resolves.toMatchObject({
			state: 'answered',
			response: { kind: 'text', value: 'fix: the parser' },
			answeredAt: FIXED_NOW
		});
	});

	it('hands back pending with a request_id when the hold elapses undecided', async () => {
		const wait = requestInput(h, { agentId, kind: 'confirm', question: 'push?' });

		await elapse(DEFAULT_HOLD_MS);

		const result = await wait;
		expect(result).toMatchObject({ state: 'pending', pollAfterMs: POLL_AFTER_MS });
		expect(result.request.id).toMatch(/^[0-9A-Z]+$/);
		// Still pending in the database: the hold ending is not a decision.
		expect(findRequest(h, result.request.id)?.state).toBe('pending');
	});

	it('holds for exactly the hold, not a millisecond less', async () => {
		const wait = requestInput(h, { agentId, kind: 'confirm', question: 'push?' });
		const settled = vi.fn();
		void wait.then(settled);

		await elapse(DEFAULT_HOLD_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		await elapse(1);
		await wait;

		expect(settled).toHaveBeenCalled();
	});

	it('await_request resumes, and returns an answer given during the second wait', async () => {
		const wait = requestInput(h, { agentId, kind: 'confirm', question: 'push?' });
		await elapse(DEFAULT_HOLD_MS);
		const first = await wait;
		expect(first.state).toBe('pending');

		const second = awaitRequest(h, { requestId: first.request.id, agentId });
		await vi.advanceTimersByTimeAsync(0);
		answerRequest(h, { requestId: first.request.id, value: true });

		await expect(second).resolves.toMatchObject({
			state: 'answered',
			response: { kind: 'confirm', value: true }
		});
	});

	it('resumes in a fresh process that never saw the request created', async () => {
		const asked = ask({ kind: 'choice', question: 'which branch?', options: ['main', 'next'] });

		// A crash: the process that asked is gone, along with its event bus. All
		// that survives is the row — which is the whole point (design §5).
		const restarted: DomainContext = context({ db: h.db, bus: new EventBus(), now: () => clock });
		const resumed = awaitRequest(restarted, { requestId: asked.id, agentId });
		await vi.advanceTimersByTimeAsync(0);
		answerRequest(restarted, { requestId: asked.id, value: 'next' });

		await expect(resumed).resolves.toMatchObject({
			state: 'answered',
			response: { kind: 'choice', value: 'next' }
		});
	});

	it('unblocks every waiter parked on the same request', async () => {
		const asked = ask({
			kind: 'buttons',
			question: 'the build failed',
			options: ['retry', 'abort']
		});

		const waiters = [
			awaitRequest(h, { requestId: asked.id, agentId }),
			awaitRequest(h, { requestId: asked.id, agentId }),
			awaitRequest(h, { requestId: asked.id, agentId })
		];
		await vi.advanceTimersByTimeAsync(0);
		answerRequest(h, { requestId: asked.id, value: 'retry' });

		for (const result of await Promise.all(waiters)) {
			expect(result).toMatchObject({ state: 'answered', response: { value: 'retry' } });
		}
	});

	it('refuses to resume another agent’s request', async () => {
		const asked = ask();
		const intruder = h.agent('intruder');

		await expect(awaitRequest(h, { requestId: asked.id, agentId: intruder })).rejects.toMatchObject(
			{
				code: 'invalid_argument'
			}
		);
	});

	it('reports not_found for a request id nothing wrote', async () => {
		await expect(awaitRequest(h, { requestId: 'nope', agentId })).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('gives up early when the caller aborts', async () => {
		const controller = new AbortController();
		const wait = requestInput(
			h,
			{ agentId, kind: 'confirm', question: 'push?' },
			{ signal: controller.signal }
		);

		controller.abort();

		await expect(wait).resolves.toMatchObject({ state: 'pending' });
	});
});

describe('a deadline that passes (design §5)', () => {
	it('turns a waiting request into a timeout, and tells the waiter', async () => {
		const wait = requestInput(h, { agentId, kind: 'confirm', question: 'push?', timeoutS: 30 });

		await elapse(30_000);

		const result = await wait;
		expect(result).toMatchObject({ state: 'timeout' });
		expect(findRequest(h, result.request.id)?.state).toBe('timeout');
		expect(h.eventNames()).toContain('request.answered');
	});

	it('bounds the wait by the deadline rather than the hold', async () => {
		const wait = requestInput(h, { agentId, kind: 'confirm', question: 'push?', timeoutS: 10 });
		const settled = vi.fn();
		void wait.then(settled);

		await elapse(10_000);

		expect(settled).toHaveBeenCalled();
		await expect(wait).resolves.toMatchObject({ state: 'timeout' });
	});

	it('refuses an answer that arrives after the deadline', async () => {
		const asked = ask({ timeoutS: 30 });
		await elapse(30_000);

		expect(() => answerRequest(h, { requestId: asked.id, value: true })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(findRequest(h, asked.id)?.state).toBe('timeout');
	});

	it('sweeps requests nobody is holding, and publishes one event each', async () => {
		ask({ timeoutS: 10 });
		ask({ timeoutS: 10 });
		const live = ask({ timeoutS: 600 });
		const stop = startRequestSweeper({ context: () => h, intervalMs: 1_000 });

		await elapse(11_000);
		stop();

		expect(listPendingRequests(h).map((request) => request.id)).toEqual([live.id]);
		expect(h.eventNames().filter((name) => name === 'request.answered')).toHaveLength(2);
	});

	it('expires nothing when no deadline has passed', () => {
		ask({ timeoutS: 600 });

		expect(expireRequests(h)).toEqual([]);
	});
});

describe('the owner dismissing a prompt', () => {
	it('unblocks a parked waiter with cancelled', async () => {
		const asked = ask();
		const wait = awaitRequest(h, { requestId: asked.id, agentId });
		await vi.advanceTimersByTimeAsync(0);

		cancelRequest(h, asked.id);

		await expect(wait).resolves.toMatchObject({ state: 'cancelled' });
		expect(findRequest(h, asked.id)?.state).toBe('cancelled');
	});

	it('cannot be dismissed twice, or after an answer', () => {
		const asked = ask();
		cancelRequest(h, asked.id);

		expect(() => cancelRequest(h, asked.id)).toThrow(expect.objectContaining({ code: 'conflict' }));
		expect(() => answerRequest(h, { requestId: asked.id, value: true })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
	});
});

/**
 * An agent taking its own question back (migration 031).
 *
 * The owner: "let an agent dismiss its own question (eg its no longer
 * relevant)." A question on their banner is a claim that an agent is blocked on
 * it, and one that has gone stale costs them a decision that no longer exists.
 *
 * Deliberately a different ending from the owner dismissing it. `cancelled` is
 * the owner declining to answer, and the agent is told so in those words;
 * blaming them for a question the agent itself withdrew would be a lie about the
 * one person who did nothing.
 */
describe('an agent withdrawing its own question', () => {
	it('ends the request as withdrawn, not as dismissed', () => {
		const asked = ask();

		withdrawRequest(h, { requestId: asked.id, agentId });

		expect(findRequest(h, asked.id)?.state).toBe('withdrawn');
	});

	it('takes it off what is waiting on the owner', () => {
		const asked = ask();
		expect(listPendingRequests(h).map((request) => request.id)).toContain(asked.id);

		withdrawRequest(h, { requestId: asked.id, agentId });

		expect(listPendingRequests(h).map((request) => request.id)).not.toContain(asked.id);
	});

	it('unblocks a parked waiter, so a second session is not left holding it', async () => {
		const asked = ask();
		const wait = awaitRequest(h, { requestId: asked.id, agentId });
		await vi.advanceTimersByTimeAsync(0);

		withdrawRequest(h, { requestId: asked.id, agentId });

		await expect(wait).resolves.toMatchObject({ state: 'withdrawn' });
	});

	it('refuses another agent`s question', () => {
		// An id copied from anywhere must not let one agent silence another's.
		const asked = ask();
		const intruder = h.agent('intruder');

		expect(() => withdrawRequest(h, { requestId: asked.id, agentId: intruder })).toThrow(
			expect.objectContaining({ code: 'invalid_argument' })
		);
		expect(findRequest(h, asked.id)?.state).toBe('pending');
	});

	it('refuses one that has already ended, whichever way it ended', () => {
		const answered = ask();
		answerRequest(h, { requestId: answered.id, value: true });
		expect(() => withdrawRequest(h, { requestId: answered.id, agentId })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);

		const dismissed = ask();
		cancelRequest(h, dismissed.id);
		expect(() => withdrawRequest(h, { requestId: dismissed.id, agentId })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);

		const withdrawn = ask();
		withdrawRequest(h, { requestId: withdrawn.id, agentId });
		expect(() => withdrawRequest(h, { requestId: withdrawn.id, agentId })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
	});

	it('loses to an answer that arrived first, and says so', () => {
		// The race worth naming: the owner answers while the agent is withdrawing.
		// Their answer stands, and the agent is told to go and read it.
		const asked = ask();
		answerRequest(h, { requestId: asked.id, value: false });

		expect(() => withdrawRequest(h, { requestId: asked.id, agentId })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(findRequest(h, asked.id)?.state).toBe('answered');
	});

	it('refuses an id that names nothing', () => {
		expect(() => withdrawRequest(h, { requestId: '01M0000000000000000000000', agentId })).toThrow(
			expect.objectContaining({ code: 'not_found' })
		);
	});
});

/**
 * The asking agent rewriting its own question (migration 033).
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 * The case that asks for it is a draft: a mistake spotted in a form's text while
 * the owner is still reading it.
 */
describe('an agent correcting its own question', () => {
	it('replaces the question and marks it edited', () => {
		const asked = ask({ question: 'ship it?' });

		const edited = editRequest(h, { requestId: asked.id, agentId, question: 'ship it to prod?' });

		expect(edited).toMatchObject({ id: asked.id, question: 'ship it to prod?', state: 'pending' });
		expect(edited.editedAt).toBe(FIXED_NOW);
		expect(findRequest(h, asked.id)?.question).toBe('ship it to prod?');
	});

	it('replaces a form`s draft, which is what this is mostly for', () => {
		const asked = ask({
			kind: 'form',
			question: 'send this?',
			options: ['Send', 'Cancel'],
			label: 'Message',
			default: 'Hi Sam, the deploy is done'
		});

		const edited = editRequest(h, {
			requestId: asked.id,
			agentId,
			default: 'Hi Sam, the deploy is done — logs are clean'
		});

		expect(edited.config).toMatchObject({
			default: 'Hi Sam, the deploy is done — logs are clean',
			// The field keeps its name: an edit of the draft must not quietly take
			// the rest of the control away with it.
			label: 'Message'
		});
	});

	it('clears the draft when asked to, without touching the rest of the control', () => {
		const asked = ask({
			kind: 'text',
			question: 'commit message?',
			default: 'fix: it',
			label: undefined
		});

		expect(editRequest(h, { requestId: asked.id, agentId, default: null }).config?.default).toBe(
			undefined
		);
	});

	it('replaces the options, and refuses ones this kind does not have', () => {
		const buttons = ask({
			kind: 'buttons',
			question: 'the build failed',
			options: ['retry', 'skip']
		});

		expect(
			editRequest(h, { requestId: buttons.id, agentId, options: ['retry', 'skip', 'abort'] })
				.options
		).toEqual(['retry', 'skip', 'abort']);

		const confirm = ask({ question: 'push?' });
		expect(() => editRequest(h, { requestId: confirm.id, agentId, options: ['a'] })).toThrow(
			expect.objectContaining({ code: 'invalid_argument' })
		);
	});

	it('refuses new options that leave the default pointing at nothing', () => {
		const asked = ask({
			kind: 'choice',
			question: 'which branch?',
			options: ['main', 'next'],
			default: 'next'
		});

		// The control would pre-select something that is no longer on the list.
		expect(() =>
			editRequest(h, { requestId: asked.id, agentId, options: ['main', 'trunk'] })
		).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
	});

	it('announces it without settling anything, so no waiter unblocks', () => {
		const asked = ask({ question: 'ship it?' });
		const before = h.eventNames().length;

		editRequest(h, { requestId: asked.id, agentId, detail: 'the canary held' });

		expect(h.eventNames().slice(before)).toEqual(['request.updated']);
		expect(findRequest(h, asked.id)?.state).toBe('pending');
	});

	it('refuses another agent`s question', () => {
		const asked = ask({ question: 'ship it?' });
		const stranger = h.agent('scout');

		expect(() =>
			editRequest(h, { requestId: asked.id, agentId: stranger, question: 'no' })
		).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
	});

	it('refuses an edit that changes nothing', () => {
		const asked = ask({ question: 'ship it?' });

		expect(() => editRequest(h, { requestId: asked.id, agentId })).toThrow(
			expect.objectContaining({ code: 'invalid_argument' })
		);
	});

	it('refuses once the question has ended, because the answer was given to the old one', () => {
		const asked = ask({ question: 'ship it?' });
		answerRequest(h, { requestId: asked.id, value: true });

		expect(() => editRequest(h, { requestId: asked.id, agentId, question: 'now?' })).toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
	});
});

describe('the server validates every answer against the request that asked for it', () => {
	/** A hostile browser, one row per kind: what it sends, and why it is refused. */
	type Ask = Omit<CreateRequestInput, 'agentId'>;
	const hostile: [string, Ask, unknown][] = [
		[
			'a choice outside the options',
			{ kind: 'choice', question: 'which?', options: ['a', 'b'] },
			'rm -rf /'
		],
		[
			'a button nobody offered',
			{ kind: 'buttons', question: 'which?', options: ['retry'] },
			'abort'
		],
		['a confirm answered with a string', { kind: 'confirm', question: 'push?' }, 'true'],
		['text answered with an object', { kind: 'text', question: 'message?' }, { evil: true }],
		[
			'a multi_choice with an option not offered',
			{ kind: 'multi_choice', question: 'delete?', options: ['a'] },
			['a', 'b']
		],
		[
			'a multi_choice under its min',
			{ kind: 'multi_choice', question: 'delete?', options: ['a', 'b'], min: 1 },
			[]
		],
		[
			'a multi_choice over its max',
			{ kind: 'multi_choice', question: 'delete?', options: ['a', 'b'], max: 1 },
			['a', 'b']
		],
		[
			'a multi_choice repeating an option to beat its max',
			{ kind: 'multi_choice', question: 'delete?', options: ['a', 'b'], min: 2 },
			['a', 'a']
		],
		[
			'text longer than the request allows',
			{ kind: 'text', question: 'name?', max: 5 },
			'far too long'
		],
		['text shorter than the request allows', { kind: 'text', question: 'name?', min: 3 }, 'ab'],
		['an empty text answer', { kind: 'text', question: 'name?' }, '   ']
	];

	it.each(hostile)('refuses %s', (_why, input, value) => {
		const asked = createRequest(h, { ...input, agentId }).request;

		expect(() => answerRequest(h, { requestId: asked.id, value })).toThrow(
			expect.objectContaining({ code: 'invalid_argument' })
		);
		expect(findRequest(h, asked.id)?.state).toBe('pending');
	});

	it('accepts the answers each kind is for, typed by kind', () => {
		const cases: [Ask, unknown, unknown][] = [
			[{ kind: 'text', question: 'message?' }, ' fix: parser ', 'fix: parser'],
			[{ kind: 'confirm', question: 'push?' }, false, false],
			[{ kind: 'buttons', question: 'which?', options: ['retry', 'skip'] }, 'skip', 'skip'],
			[{ kind: 'choice', question: 'which?', options: ['main'] }, 'main', 'main'],
			[
				{ kind: 'multi_choice', question: 'delete?', options: ['a', 'b', 'c'] },
				['a', 'c'],
				['a', 'c']
			]
		];

		for (const [input, value, expected] of cases) {
			const asked = createRequest(h, { ...input, agentId }).request;

			const answered = answerRequest(h, { requestId: asked.id, value });

			expect(answered.answer, input.kind).toEqual({ kind: input.kind, value: expected });
			expect(answered.state, input.kind).toBe('answered');
		}
	});

	it('records a confirm in the table’s own vocabulary as well as the structured answer', () => {
		const yes = answerRequest(h, { requestId: ask().id, value: true });
		const no = answerRequest(h, { requestId: ask().id, value: false });

		expect(yes.answer).toEqual({ kind: 'confirm', value: true });
		expect(no.answer).toEqual({ kind: 'confirm', value: false });
	});

	it('checks an answer without needing a database, for anything that wants the rule alone', () => {
		const request = ask({ kind: 'multi_choice', question: 'which?', options: ['a', 'b'], min: 1 });

		expect(validateAnswer(request, ['b'])).toEqual({ kind: 'multi_choice', value: ['b'] });
		expect(() => validateAnswer(request, [])).toThrow(/at least 1/);
	});
});

describe('the queue the owner sees (design §7)', () => {
	it('lists every outstanding request, longest-blocked first, and loses none', () => {
		const asks = ['one?', 'two?', 'three?'].map((question) => ask({ question }));
		const other = h.agent('scout');
		createRequest(h, { agentId: other, kind: 'text', question: 'four?' });

		expect(listPendingRequests(h).map((request) => request.question)).toEqual([
			'one?',
			'two?',
			'three?',
			'four?'
		]);
		expect(asks).toHaveLength(3);
	});

	it('drops a request that has settled, however it settled', () => {
		const answered = ask({ question: 'answered?' });
		const dismissed = ask({ question: 'dismissed?' });
		const waiting = ask({ question: 'waiting?' });
		answerRequest(h, { requestId: answered.id, value: true });
		cancelRequest(h, dismissed.id);

		expect(listPendingRequests(h).map((request) => request.id)).toEqual([waiting.id]);
	});

	it('hides a request whose deadline has passed but which nothing has swept yet', () => {
		ask({ timeoutS: 10 });
		clock += 11_000;

		expect(listPendingRequests(h)).toEqual([]);
	});

	it('counts what is waiting on the owner, per agent, for the heartbeat', () => {
		const other = h.agent('scout');
		ask();
		ask();
		createRequest(h, { agentId: other, kind: 'text', question: 'mine?' });

		expect(countPendingRequests(h, agentId)).toBe(2);
		expect(countPendingRequests(h, other)).toBe(1);
	});
});

describe('rows written before this slice existed', () => {
	it('reads an old approval as a confirm that was answered', () => {
		const db: Db = h.db;
		const row = insertApproval(db, {
			agentId,
			question: 'ship it?',
			expiresAt: FIXED_NOW + 1000,
			state: 'approved'
		});

		expect(findRequest(h, row.id)).toMatchObject({
			kind: 'confirm',
			state: 'answered',
			answer: { kind: 'confirm', value: true }
		});
	});
});

/**
 * The generic kind (design §5).
 *
 * `form` exists because the other five each answer one question, and a real
 * approval is usually two: "here is the Slack message I am about to send" is a
 * draft to edit *and* a decision to take. Asking twice means one of the two is
 * answered about text that has already changed.
 */
describe('form requests: an editable draft plus the agent’s own actions', () => {
	const ask = (over: Partial<CreateRequestInput> = {}): OwnerRequest =>
		createRequest(h, {
			agentId,
			kind: 'form',
			question: 'Send this to #general?',
			options: ['Approve', 'Reject'],
			default: 'Deploy is done. 12 minutes, no rollbacks.',
			label: 'Message',
			multiline: true,
			...over
		}).request;

	it('stores the actions as options and the draft as the default', () => {
		expect(ask()).toMatchObject({
			kind: 'form',
			options: ['Approve', 'Reject'],
			config: {
				default: 'Deploy is done. 12 minutes, no rollbacks.',
				label: 'Message',
				multiline: true
			}
		});
	});

	it('needs at least one action, or the owner has no way to answer', () => {
		expect(() => ask({ options: [] })).toThrow(/at least one option/);
	});

	it('does not require the draft to be one of the actions', () => {
		// The check every other listed kind applies would reject this, because for
		// them the default *is* one of the options. A form's two halves are unrelated.
		expect(ask({ default: 'anything at all' }).config?.default).toBe('anything at all');
	});

	it('takes a label, which no other kind has a field to name', () => {
		expect(() =>
			createRequest(h, { agentId, kind: 'text', question: 'q?', label: 'Message' })
		).toThrow(/label/);
	});

	it('answers with the action taken and the text as the owner left it', () => {
		const request = ask();

		const answered = answerRequest(h, {
			requestId: request.id,
			value: { action: 'Approve', text: '  Deploy done. No rollbacks.  ' }
		});

		expect(answered.answer).toEqual({
			kind: 'form',
			value: { action: 'Approve', text: 'Deploy done. No rollbacks.' }
		});
	});

	it('refuses an action it never offered', () => {
		const request = ask();

		expect(() =>
			answerRequest(h, { requestId: request.id, value: { action: 'Send anyway', text: 'x' } })
		).toThrow(/not one of the actions/);
	});

	it('refuses half an answer, either half', () => {
		const request = ask();

		expect(() => validateAnswer(request, { action: 'Approve' })).toThrow(/text is a string/);
		expect(() => validateAnswer(request, { text: 'hello' })).toThrow(/not one of the actions/);
		expect(() => validateAnswer(request, 'Approve')).toThrow(/{ action, text }/);
		expect(() => validateAnswer(request, ['Approve'])).toThrow(/{ action, text }/);
	});

	it('bounds the text with min and max, in characters', () => {
		const request = ask({ min: 5, max: 20 });

		expect(() => validateAnswer(request, { action: 'Approve', text: 'hi' })).toThrow(
			/at least 5 characters/
		);
		expect(() => validateAnswer(request, { action: 'Approve', text: 'x'.repeat(21) })).toThrow(
			/at most 20 characters/
		);
	});

	it('lets the owner reject without the text having to be valid to send', () => {
		const request = ask();

		expect(validateAnswer(request, { action: 'Reject', text: '' })).toEqual({
			kind: 'form',
			value: { action: 'Reject', text: '' }
		});
	});

	it('records the action as the readable scalar, with the text in the answer', () => {
		const request = ask();
		answerRequest(h, { requestId: request.id, value: { action: 'Approve', text: 'sent' } });

		const row = h.db
			.prepare(`SELECT decided_value AS scalar FROM approvals WHERE id = ?`)
			.get(request.id) as { scalar: string };
		expect(row.scalar).toBe('Approve');
	});
});

/**
 * Asking inside a thread (migration 022).
 *
 * The owner's ask: "Allow agents to ask questions in replies." An agent already
 * talking to them had to leave the conversation to ask for a decision, so the
 * question arrived with none of the context that produced it.
 */
describe('a question asked in a thread', () => {
	it('takes the thread, the card and the project from the message', () => {
		const h = harness();
		const agentId = h.agent('scout');
		const { project } = createProject(h, { name: 'Agent Dashboard' });
		const update = postUpdate(h, { project: project.slug, agentId, body: 'shipped' });
		const said = postMessage(h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'does it handle empty input?'
		});

		const { request } = createRequest(h, {
			agentId,
			kind: 'confirm',
			question: 'Should it refuse empty input, or accept it?',
			message: said.id
		});

		expect(request).toMatchObject({
			messageId: said.id,
			updateId: update.id,
			projectId: project.id
		});
	});

	it('works in one of the owner’s own feed posts, which is on no card', () => {
		const h = harness();
		const agentId = h.agent('scout');
		const { project } = createProject(h, { name: 'Agent Dashboard' });
		const post = postMessage(h, {
			author: { kind: 'human' },
			project: project.slug,
			body: 'have a look at the deploy'
		});

		const { request } = createRequest(h, {
			agentId,
			kind: 'buttons',
			question: 'Which environment?',
			options: ['staging', 'production'],
			message: post.id
		});

		expect(request).toMatchObject({
			messageId: post.id,
			updateId: null,
			projectId: project.id
		});
	});

	it('refuses a message that is not there, rather than asking into the void', () => {
		const h = harness();
		const agentId = h.agent('scout');

		let code = 'no error';
		try {
			createRequest(h, {
				agentId,
				kind: 'confirm',
				question: 'anybody?',
				message: 'nope'
			});
		} catch (error) {
			code = (error as { code: string }).code;
		}

		expect(code).toBe('not_found');
	});

	it('leaves an ordinary request anchored to nothing in particular', () => {
		const h = harness();
		const agentId = h.agent('scout');

		const { request } = createRequest(h, { agentId, kind: 'confirm', question: 'Ship it?' });

		expect(request.messageId).toBeNull();
	});
});

/**
 * Picture questions: an agent puts an image on an option, so the owner picks
 * the picture itself. The owner: "let an agent attach images to the buttons on
 * a form, so you can select an image directly."
 */
describe('options with pictures', () => {
	const image = (over: Partial<Parameters<typeof insertMedia>[1]> = {}) =>
		insertMedia(h.db, {
			agentId,
			kind: 'image',
			mime: 'image/png',
			bytes: 10,
			sha256: `sha-${Math.random()}`,
			status: 'ready',
			...over
		}).id;

	it('stores which picture goes with which option, and attaches them to the question', () => {
		const red = image();
		const blue = image();

		const request = ask({
			kind: 'choice',
			options: ['Red', 'Blue', 'Neither'],
			optionMedia: { Red: red, Blue: blue }
		});

		expect(request.config?.optionMedia).toEqual({ Red: red, Blue: blue });
		expect(findMediaById(h.db, red)?.requestId).toBe(request.id);
		expect(findMediaById(h.db, blue)?.requestId).toBe(request.id);
	});

	it('works for buttons and multi_choice too', () => {
		expect(
			ask({ kind: 'buttons', options: ['A', 'B'], optionMedia: { A: image() } }).config?.optionMedia
		).toBeDefined();
		expect(
			ask({ kind: 'multi_choice', options: ['A', 'B'], optionMedia: { B: image() } }).config
				?.optionMedia
		).toBeDefined();
	});

	it('refuses a picture for an option that was not offered', () => {
		expect(() =>
			ask({ kind: 'choice', options: ['Red'], optionMedia: { Green: image() } })
		).toThrow(/Green is not one of the options/);
	});

	it('refuses something that is not a picture', () => {
		const pdf = image({ kind: 'file', mime: 'application/pdf' });
		expect(() => ask({ kind: 'choice', options: ['Red'], optionMedia: { Red: pdf } })).toThrow(
			/must be an image/
		);
	});

	it('refuses pictures on a kind with nothing to pick', () => {
		expect(() => ask({ kind: 'confirm', optionMedia: { yes: image() } })).toThrow(
			/buttons, choice or multi_choice/
		);
		expect(() => ask({ kind: 'form', options: ['Send'], optionMedia: { Send: image() } })).toThrow(
			/buttons, choice or multi_choice/
		);
	});

	it('refuses the same picture on two options', () => {
		const one = image();
		expect(() =>
			ask({ kind: 'choice', options: ['A', 'B'], optionMedia: { A: one, B: one } })
		).toThrow(/once/);
	});

	it('forgets the picture of an option that an edit removes', () => {
		const red = image();
		const blue = image();
		const request = ask({
			kind: 'choice',
			options: ['Red', 'Blue'],
			optionMedia: { Red: red, Blue: blue }
		});

		const edited = editRequest(h, { requestId: request.id, agentId, options: ['Red', 'Green'] });

		expect(edited.config?.optionMedia).toEqual({ Red: red });
	});
});
