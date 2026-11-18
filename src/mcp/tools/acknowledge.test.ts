import { describe, expect, it } from 'vitest';
import { acknowledgementsFor, createProject, postMessage, postUpdate } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { acknowledgeTool } from './acknowledge';

/**
 * `acknowledge` (migration 013) — the answer to a card that says nothing back.
 *
 * The thing worth proving over the tool boundary is attribution: there is no
 * agent argument, so what lands in the table is the bearer token's agent and
 * nothing a caller can influence.
 */
function aMessage(mcp: McpHarness, body = 'have a look at the migration') {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const message = postMessage(mcp.h, {
		project: project.slug,
		author: { kind: 'human' },
		body
	});
	return { project, message };
}

describe('saying you have seen it', () => {
	it('records "thinking" against the message, attributed to the token', async () => {
		const mcp = mcpHarness();
		const { message } = aMessage(mcp);

		const result = await acknowledgeTool.run(mcp.deps, {
			state: 'thinking',
			message_id: message.id
		});

		expect(result.isError).toBeFalsy();
		expect(acknowledgementsFor(mcp.h, { message: [message.id] })).toMatchObject([
			{ agentId: mcp.deps.agent.id, state: 'thinking', taskId: null }
		]);
	});

	it('replaces it with "done" rather than filing a second acknowledgement', async () => {
		const mcp = mcpHarness();
		const { message } = aMessage(mcp);
		await acknowledgeTool.run(mcp.deps, { state: 'thinking', message_id: message.id });

		await acknowledgeTool.run(mcp.deps, { state: 'done', message_id: message.id });

		expect(acknowledgementsFor(mcp.h, { message: [message.id] })).toMatchObject([
			{ state: 'done' }
		]);
	});

	it('works on an update, not only on a message', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const update = postUpdate(mcp.h, {
			project: project.slug,
			agentId: mcp.deps.agent.id,
			body: 'shipped'
		});

		const result = await acknowledgeTool.run(mcp.deps, { state: 'done', update_id: update.id });

		expect(result.isError).toBeFalsy();
		expect(acknowledgementsFor(mcp.h, { update: [update.id] })).toMatchObject([{ state: 'done' }]);
	});

	it('says which state it recorded, so the answer is readable without the payload', async () => {
		const mcp = mcpHarness();
		const { message } = aMessage(mcp);

		const result = await acknowledgeTool.run(mcp.deps, { state: 'done', message_id: message.id });

		expect(toolText(result)).toContain('tick');
	});

	it('refuses a call naming no card, and one naming two', async () => {
		const mcp = mcpHarness();
		const { project, message } = aMessage(mcp);
		const update = postUpdate(mcp.h, {
			project: project.slug,
			agentId: mcp.deps.agent.id,
			body: 'shipped'
		});

		expect((await acknowledgeTool.run(mcp.deps, { state: 'done' })).isError).toBe(true);
		expect(
			(
				await acknowledgeTool.run(mcp.deps, {
					state: 'done',
					message_id: message.id,
					update_id: update.id
				})
			).isError
		).toBe(true);
	});

	it('refuses a message that is not there', async () => {
		const mcp = mcpHarness();

		const result = await acknowledgeTool.run(mcp.deps, { state: 'done', message_id: 'nope' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('not_found');
	});
});
