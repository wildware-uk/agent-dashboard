import { describe, expect, it } from 'vitest';
import { answerRequest, createRequest, findRequest, listAgents } from '$domain';
import { mcpHarness } from '../testing';
import { editRequestTool } from './edit-request';

/**
 * `edit_request` (migration 033) — the asking agent rewriting its own question.
 *
 * The case that asks for it is a draft: an agent puts a message in a `form`,
 * spots a mistake in it while the owner is still reading, and without this has
 * to withdraw and ask again — throwing away whatever they had already typed.
 */
function aDraft(mcp: ReturnType<typeof mcpHarness>) {
	return createRequest(mcp.h, {
		agentId: mcp.deps.agent.id,
		kind: 'form',
		question: 'send this?',
		options: ['Send', 'Cancel'],
		label: 'Message',
		default: 'Hi Sam, the deploy is done'
	}).request;
}

describe('correcting a question you are waiting on', () => {
	it('replaces the draft in the field, keeping the rest of the control', async () => {
		const mcp = mcpHarness();
		const asked = aDraft(mcp);

		const result = await editRequestTool.run(mcp.deps, {
			request_id: asked.id,
			default: 'Hi Sam, the deploy is done — logs are clean'
		});

		expect(result.isError).toBeFalsy();
		expect(findRequest(mcp.h, asked.id)?.config).toMatchObject({
			default: 'Hi Sam, the deploy is done — logs are clean',
			label: 'Message'
		});
	});

	it('reports the question back as the owner now sees it', async () => {
		const mcp = mcpHarness();
		const asked = aDraft(mcp);

		const result = await editRequestTool.run(mcp.deps, {
			request_id: asked.id,
			question: 'send this instead?'
		});

		expect(result.structuredContent).toMatchObject({
			request: { id: asked.id, question: 'send this instead?' }
		});
	});

	it('leaves the wait alone: nothing is settled by an edit', async () => {
		const mcp = mcpHarness();
		const asked = aDraft(mcp);

		await editRequestTool.run(mcp.deps, { request_id: asked.id, detail: 'the canary held' });

		expect(findRequest(mcp.h, asked.id)?.state).toBe('pending');
	});

	it('refuses another agent`s question', async () => {
		const mcp = mcpHarness({ name: 'scout' });
		const intruderId = mcp.mint('intruder').agentId;
		const intruder = listAgents(mcp.h).find((candidate) => candidate.id === intruderId)!;
		const asked = aDraft(mcp);

		const result = await editRequestTool.run(
			{ ...mcp.deps, agent: intruder },
			{ request_id: asked.id, question: 'mine?' }
		);

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
		expect(findRequest(mcp.h, asked.id)?.question).toBe('send this?');
	});

	it('refuses one that has already been answered', async () => {
		const mcp = mcpHarness();
		const asked = aDraft(mcp);
		answerRequest(mcp.h, { requestId: asked.id, value: { action: 'Send', text: 'sent' } });

		expect(
			await editRequestTool.run(mcp.deps, { request_id: asked.id, question: 'too late?' })
		).toMatchObject({ isError: true, structuredContent: { error: 'conflict' } });
	});
});
