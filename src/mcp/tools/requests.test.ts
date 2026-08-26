import { describe, expect, it } from 'vitest';
import {
	answerRequest,
	cancelRequest,
	createProject,
	listAgents,
	listPendingRequests,
	postUpdate,
	type RequestKind
} from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { awaitRequestTool } from './await-request';
import { requestInputTool } from './request-input';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A hold short enough that a test can wait it out for real. */
const HOLD_MS = 20;

const harness = () => mcpHarness({ name: 'claude', holdMs: HOLD_MS });

type Args = Record<string, unknown>;

const askFor = (mcp: McpHarness, args: Args) =>
	requestInputTool.run(mcp.deps, args as never) as Promise<CallToolResult>;

const resume = (mcp: McpHarness, requestId: string) =>
	awaitRequestTool.run(mcp.deps, { request_id: requestId }) as Promise<CallToolResult>;

/** The structured half of a result, which is what an agent parses. */
const body = (result: CallToolResult) => result.structuredContent as Record<string, unknown>;

describe('all five kinds round-trip through the tools (design §5)', () => {
	/** What the agent asks, what the owner clicks, and what must come back. */
	const kinds: [RequestKind, Args, unknown, unknown][] = [
		['text', { question: 'commit message?' }, 'fix: the parser', 'fix: the parser'],
		['confirm', { question: 'push to main?' }, true, true],
		[
			'buttons',
			{ question: 'the build failed', options: ['retry', 'skip', 'abort'] },
			'retry',
			'retry'
		],
		['choice', { question: 'which branch?', options: ['main', 'next'] }, 'next', 'next'],
		[
			'multi_choice',
			{ question: 'which files should I delete?', options: ['a.ts', 'b.ts', 'c.ts'] },
			['a.ts', 'c.ts'],
			['a.ts', 'c.ts']
		]
	];

	it.each(kinds)(
		'%s comes back as the value its kind promises',
		async (kind, args, click, value) => {
			const mcp = harness();

			const asked = askFor(mcp, { kind, ...args });
			// The prompt is on the owner's screen the moment the call is made, which is
			// what lets them answer inside the hold.
			const [pending] = listPendingRequests(mcp.h);
			answerRequest(mcp.h, { requestId: pending.id, value: click });

			expect(body(await asked)).toMatchObject({
				state: 'answered',
				request_id: pending.id,
				response: { kind, value }
			});
		}
	);

	it('says what the owner answered in words, ahead of the JSON', async () => {
		const mcp = harness();
		const asked = askFor(mcp, { kind: 'confirm', question: 'push?' });
		answerRequest(mcp.h, { requestId: listPendingRequests(mcp.h)[0].id, value: false });

		expect(toolText(await asked)).toContain('no.');
	});
});

describe('the bounded long-poll, as an agent experiences it', () => {
	it('hands back pending and a request_id when the hold elapses', async () => {
		const mcp = harness();

		const result = body(await askFor(mcp, { kind: 'confirm', question: 'push?' }));

		expect(result).toMatchObject({ state: 'pending', poll_after_ms: expect.any(Number) });
		expect(result.request_id).toBe(listPendingRequests(mcp.h)[0].id);
	});

	it('tells the agent, in the result text, to call await_request and keep looping', async () => {
		const mcp = harness();

		const text = toolText(await askFor(mcp, { kind: 'confirm', question: 'push?' }));

		expect(text).toContain('await_request');
		expect(text).toContain('pending');
	});

	it('resumes on await_request and returns an answer given during the second wait', async () => {
		const mcp = harness();
		const first = body(await askFor(mcp, { kind: 'text', question: 'commit message?' }));
		const requestId = first.request_id as string;

		const second = resume(mcp, requestId);
		answerRequest(mcp.h, { requestId, value: 'fix: the parser' });

		expect(body(await second)).toMatchObject({
			state: 'answered',
			response: { kind: 'text', value: 'fix: the parser' }
		});
	});

	it('answers pending again when the second wait also elapses, so the loop continues', async () => {
		const mcp = harness();
		const requestId = body(await askFor(mcp, { kind: 'confirm', question: 'push?' }))
			.request_id as string;

		expect(body(await resume(mcp, requestId))).toMatchObject({
			state: 'pending',
			request_id: requestId
		});
	});

	it('reports a dismissal as cancelled, and says it is not permission', async () => {
		const mcp = harness();
		const requestId = body(await askFor(mcp, { kind: 'confirm', question: 'push?' }))
			.request_id as string;

		const resumed = resume(mcp, requestId);
		cancelRequest(mcp.h, requestId);
		const result = await resumed;

		expect(body(result)).toMatchObject({ state: 'cancelled' });
		expect(toolText(result)).toContain('not permission');
	});

	it('reports a deadline that passed as timeout, whoever was waiting', async () => {
		// A clock the test moves, so a five second deadline does not cost five
		// seconds of test time. The hold stays real, and short.
		let clock = Date.now();
		const mcp = mcpHarness({ name: 'claude', holdMs: HOLD_MS, now: () => clock });

		const first = body(await askFor(mcp, { kind: 'confirm', question: 'push?', timeout_s: 5 }));
		expect(first).toMatchObject({ state: 'pending' });
		clock += 6_000;

		const result = await resume(mcp, first.request_id as string);
		expect(body(result)).toMatchObject({ state: 'timeout' });
		expect(toolText(result)).toContain('not permission');
	});
});

describe('identity comes from the token, not from an argument', () => {
	it('refuses to resume a request that belongs to another agent', async () => {
		const mcp = harness();
		const requestId = body(await askFor(mcp, { kind: 'confirm', question: 'push?' }))
			.request_id as string;
		const intruderId = mcp.mint('intruder').agentId;
		const intruder = listAgents(mcp.h).find((agent) => agent.id === intruderId)!;

		const result = (await awaitRequestTool.run(
			{ ...mcp.deps, agent: intruder },
			{ request_id: requestId }
		)) as CallToolResult;

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
	});

	it('takes no agent argument at all: the schemas have no room for one', () => {
		expect(Object.keys(requestInputTool.config.inputSchema)).not.toContain('agent_id');
		expect(Object.keys(awaitRequestTool.config.inputSchema)).not.toContain('agent_id');
	});
});

describe('refusals an agent can act on', () => {
	it('reports a request that contradicts itself as invalid_argument', async () => {
		const mcp = harness();

		const result = await askFor(mcp, { kind: 'choice', question: 'which?' });

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
	});

	it('reports an unknown request id as not_found', async () => {
		const mcp = harness();

		expect(await resume(mcp, 'nope')).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
	});

	it('reports an unknown project as not_found rather than asking anyway', async () => {
		const mcp = harness();

		expect(
			await askFor(mcp, { kind: 'confirm', question: 'push?', project: 'nope' })
		).toMatchObject({ isError: true, structuredContent: { error: 'not_found' } });
		expect(listPendingRequests(mcp.h)).toEqual([]);
	});
});

describe('what the prompt is about', () => {
	it('anchors to a project and to an update, and reports both back', async () => {
		const mcp = harness();
		const project = createProject(mcp.h, { name: 'Dash' }).project;
		const update = postUpdate(mcp.h, {
			project: project.slug,
			agentId: mcp.deps.agent.id,
			body: 'ready to push'
		});

		const result = body(
			await askFor(mcp, { kind: 'confirm', question: 'push?', update: update.id })
		);

		expect(result.request).toMatchObject({
			project_id: project.id,
			update_id: update.id,
			kind: 'confirm',
			question: 'push?'
		});
	});
});

describe('the tool descriptions are the contract (design §5)', () => {
	it('teaches the resume loop, because nothing else can', () => {
		for (const tool of [requestInputTool, awaitRequestTool]) {
			const description = tool.config.description;

			expect(description, tool.name).toContain('await_request');
			expect(description, tool.name).toContain('request_id');
			expect(description.toLowerCase(), tool.name).toContain('pending');
			// The two outcomes an agent must not read as a yes.
			expect(description, tool.name).toContain('timeout');
			expect(description, tool.name).toContain('cancelled');
		}
	});

	it('names every kind, and what each one answers with', () => {
		const description = requestInputTool.config.description;

		for (const kind of ['text', 'confirm', 'buttons', 'choice', 'multi_choice']) {
			expect(description, kind).toContain(kind);
		}
		expect(description).toContain('survives your own restart');
	});
});
