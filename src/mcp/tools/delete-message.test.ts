import { describe, expect, it } from 'vitest';
import { createProject, listThread, postMessage, postUpdate } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { deleteMessageTool } from './delete-message';

/**
 * `delete_message` (migration 017) — an agent unsending its own line.
 *
 * The rule under test is who may do it. Everything else about a delete is the
 * domain's, and tested there; what an adapter can get wrong is identity, and
 * getting it wrong here would let one agent silence another — or the owner.
 */

function aThread(mcp: McpHarness) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'shipped'
	});
	return { project, update };
}

describe('unsending your own message', () => {
	it('takes the line out of the thread', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const said = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			updateId: update.id,
			body: 'posted this too soon'
		});

		const result = await deleteMessageTool.run(mcp.deps, { message_id: said.id });

		expect(result.isError).toBeFalsy();
		expect(toolText(result)).toContain('Unsent');
		expect(listThread(mcp.h, { updateId: update.id })).toEqual([]);
	});

	it('refuses the owner’s message, however it is asked for', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const theirs = postMessage(mcp.h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'do the thing'
		});

		const result = await deleteMessageTool.run(mcp.deps, { message_id: theirs.id });

		expect(result.isError).toBe(true);
		expect(listThread(mcp.h, { updateId: update.id })).toHaveLength(1);
	});

	it('refuses another agent’s message', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const other = mcp.mint('other-agent');
		const theirs = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: other.agentId },
			updateId: update.id,
			body: 'mine, not yours'
		});

		const result = await deleteMessageTool.run(mcp.deps, { message_id: theirs.id });

		expect(result.isError).toBe(true);
		expect(listThread(mcp.h, { updateId: update.id })).toHaveLength(1);
	});

	it('says so plainly when there is no such message', async () => {
		const mcp = mcpHarness();

		const result = await deleteMessageTool.run(mcp.deps, { message_id: 'nope' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('no such message');
	});
});
