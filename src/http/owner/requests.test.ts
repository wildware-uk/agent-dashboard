import { beforeEach, describe, expect, it } from 'vitest';
import {
	awaitRequest,
	createRequest,
	findRequest,
	listPendingRequests,
	type CreateRequestInput,
	type OwnerRequest
} from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { answerRequestHandler, dismissRequestHandler, type OwnerHandler } from './requests';
import { readRequestsSnapshot } from '../stream';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('claude');
});

const ask = (over: Partial<CreateRequestInput> = {}): OwnerRequest =>
	createRequest(h, { agentId, kind: 'confirm', question: 'push to main?', ...over }).request;

type CallOptions = {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
	/** Signed session by default; pass `null` for a caller with no cookie. */
	cookie?: string | null;
};

async function call(factory: (options: object) => OwnerHandler, options: CallOptions = {}) {
	const handler = factory({ ctx: () => h, config });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const init: RequestInit = { method: options.method ?? 'POST' };
	if (options.body !== undefined) init.body = JSON.stringify(options.body);

	const response = await handler({
		request: new Request('http://dash.test/api/requests/x/answer', init),
		params: options.params ?? {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

const answer = (request: OwnerRequest, value: unknown) =>
	call(answerRequestHandler, { params: { id: request.id }, body: { value } });

describe('answering from the browser (design §5, §7)', () => {
	it('records the answer, publishes once, and hands the settled request back', async () => {
		const request = ask({ kind: 'choice', question: 'which branch?', options: ['main', 'next'] });
		h.events.length = 0;

		const { response, body } = await answer(request, 'next');

		expect(response.status).toBe(200);
		expect(body.request).toMatchObject({
			state: 'answered',
			answer: { kind: 'choice', value: 'next' }
		});
		expect(h.eventNames()).toEqual(['request.answered']);
	});

	it('answers each of the five kinds with the value that kind is for', async () => {
		const cases: [Partial<CreateRequestInput>, unknown, unknown][] = [
			[{ kind: 'text', question: 'commit message?' }, 'fix: parser', 'fix: parser'],
			[{ kind: 'confirm' }, true, true],
			[{ kind: 'buttons', options: ['retry', 'abort'] }, 'abort', 'abort'],
			[{ kind: 'choice', options: ['main', 'next'] }, 'main', 'main'],
			[{ kind: 'multi_choice', options: ['a', 'b', 'c'] }, ['a', 'b'], ['a', 'b']]
		];

		for (const [over, value, expected] of cases) {
			const { body } = await answer(ask(over), value);

			expect(body.request.answer, String(over.kind)).toEqual({ kind: over.kind, value: expected });
		}
	});

	it('unblocks an agent parked on the request', async () => {
		const request = ask();
		const parked = awaitRequest(h, { requestId: request.id, agentId });

		await answer(request, true);

		await expect(parked).resolves.toMatchObject({
			state: 'answered',
			response: { kind: 'confirm', value: true }
		});
	});

	it('refuses a second answer with 409 rather than overwriting the first', async () => {
		const request = ask();
		await answer(request, true);

		const { response, body } = await answer(request, false);

		expect(response.status).toBe(409);
		expect(body.error).toBe('conflict');
		expect(findRequest(h, request.id)?.answer).toEqual({ kind: 'confirm', value: true });
	});

	it('answers 404 for a request id nothing wrote', async () => {
		const { response, body } = await call(answerRequestHandler, {
			params: { id: 'nope' },
			body: { value: true }
		});

		expect(response.status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('refuses a caller with no session, and leaves the request pending', async () => {
		const request = ask();

		const { response, body } = await call(answerRequestHandler, {
			params: { id: request.id },
			body: { value: true },
			cookie: null
		});

		expect(response.status).toBe(401);
		expect(body.error).toBe('unauthenticated');
		expect(findRequest(h, request.id)?.state).toBe('pending');
	});
});

/**
 * The half of this slice that has to survive a client that is lying.
 *
 * These post straight at the endpoint, not through the UI, because that is what
 * an attacker does — and because the agent on the other side is about to *act*
 * on whatever comes back (design §5).
 */
describe('a hostile answer is refused server-side', () => {
	const hostile: [string, Partial<CreateRequestInput>, unknown][] = [
		['an option nobody offered', { kind: 'choice', options: ['main', 'next'] }, 'rm -rf /'],
		['a button nobody offered', { kind: 'buttons', options: ['retry'] }, 'abort'],
		['a confirm answered with a truthy string', { kind: 'confirm' }, 'true'],
		['a confirm answered with a number', { kind: 'confirm' }, 1],
		['a text answer that is an object', { kind: 'text' }, { toString: 'evil' }],
		[
			'a multi_choice smuggling an option in',
			{ kind: 'multi_choice', options: ['a', 'b'] },
			['a', 'c']
		],
		[
			'a multi_choice over the max it was given',
			{ kind: 'multi_choice', options: ['a', 'b', 'c'], max: 1 },
			['a', 'b']
		],
		[
			'a multi_choice under the min it was given',
			{ kind: 'multi_choice', options: ['a', 'b'], min: 1 },
			[]
		],
		[
			'a multi_choice repeating one option to beat its min',
			{ kind: 'multi_choice', options: ['a', 'b'], min: 2 },
			['a', 'a']
		],
		['a text answer longer than the request allows', { kind: 'text', max: 5 }, 'far too long'],
		['a nested object where a list belongs', { kind: 'multi_choice', options: ['a'] }, { 0: 'a' }]
	];

	it.each(hostile)(
		'refuses %s with 400, leaving the request pending',
		async (_why, over, value) => {
			const request = ask({ question: 'careful?', ...over });

			const { response, body } = await answer(request, value);

			expect(response.status).toBe(400);
			expect(body.error).toBe('invalid_argument');
			expect(findRequest(h, request.id)?.state).toBe('pending');
		}
	);

	it('refuses a body with no value at all rather than answering with undefined', async () => {
		const request = ask();

		const { response } = await call(answerRequestHandler, {
			params: { id: request.id },
			body: { answer: true }
		});

		expect(response.status).toBe(400);
		expect(findRequest(h, request.id)?.state).toBe('pending');
	});
});

describe('dismissing from the browser', () => {
	it('cancels the request and unblocks whoever was parked on it', async () => {
		const request = ask();
		const parked = awaitRequest(h, { requestId: request.id, agentId });

		const { response, body } = await call(dismissRequestHandler, {
			method: 'DELETE',
			params: { id: request.id }
		});

		expect(response.status).toBe(200);
		expect(body.request.state).toBe('cancelled');
		await expect(parked).resolves.toMatchObject({ state: 'cancelled' });
	});

	it('refuses to dismiss something already settled', async () => {
		const request = ask();
		await answer(request, true);

		const { response } = await call(dismissRequestHandler, {
			method: 'DELETE',
			params: { id: request.id }
		});

		expect(response.status).toBe(409);
	});

	it('refuses a caller with no session', async () => {
		const request = ask();

		const { response } = await call(dismissRequestHandler, {
			method: 'DELETE',
			params: { id: request.id },
			cookie: null
		});

		expect(response.status).toBe(401);
		expect(findRequest(h, request.id)?.state).toBe('pending');
	});
});

describe('the snapshot the banner reads', () => {
	it('lists every outstanding request, longest-blocked first', () => {
		const first = ask({ question: 'one?' });
		const second = ask({ question: 'two?', kind: 'text' });

		expect(readRequestsSnapshot(h).requests.map((request) => request.id)).toEqual([
			first.id,
			second.id
		]);
	});

	it('drops one the owner has answered, and keeps the rest', async () => {
		const answered = ask({ question: 'one?' });
		const waiting = ask({ question: 'two?' });
		await answer(answered, true);

		expect(readRequestsSnapshot(h).requests.map((request) => request.id)).toEqual([waiting.id]);
		expect(listPendingRequests(h)).toHaveLength(1);
	});
});
