import { describe, expect, it } from 'vitest';
import { createProject, postMessage, postUpdate, reactionsFor } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { reactTool } from './react';

/**
 * `react` (migration 024) — the cheapest thing an agent can say.
 *
 * The owner asked for reactions and pointed out they could stand in for the
 * acknowledgement system: an eyes reaction is "I have this" in one call. What
 * matters at this layer is identity (it reacts as itself, never as the owner)
 * and that a retry does not undo the reaction it thought it was making.
 */
function aMessage(mcp: McpHarness) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'shipped'
	});
	return postMessage(mcp.h, {
		author: { kind: 'human' },
		updateId: update.id,
		body: 'have a look at this'
	});
}

describe('reacting as an agent', () => {
	it('puts the emoji on the message, as itself', async () => {
		const mcp = mcpHarness();
		const message = aMessage(mcp);

		const result = await reactTool.run(mcp.deps, { message_id: message.id, emoji: ':eyes:' });

		expect(result.isError).toBeFalsy();
		expect(toolText(result)).toContain('Reacted');
		expect(reactionsFor(mcp.h, [message.id])).toEqual([
			expect.objectContaining({ emoji: '👀', actor: `agent:${mcp.deps.agent.id}` })
		]);
	});

	it('is safe to retry when it says which way it means', async () => {
		const mcp = mcpHarness();
		const message = aMessage(mcp);

		await reactTool.run(mcp.deps, { message_id: message.id, emoji: '✅', on: true });
		await reactTool.run(mcp.deps, { message_id: message.id, emoji: '✅', on: true });

		// A toggle would have undone it; saying `on: true` twice is one reaction.
		expect(reactionsFor(mcp.h, [message.id])).toHaveLength(1);
	});

	it('takes one back', async () => {
		const mcp = mcpHarness();
		const message = aMessage(mcp);
		await reactTool.run(mcp.deps, { message_id: message.id, emoji: '👍', on: true });

		const result = await reactTool.run(mcp.deps, {
			message_id: message.id,
			emoji: '👍',
			on: false
		});

		expect(toolText(result)).toContain('removed');
		expect(reactionsFor(mcp.h, [message.id])).toEqual([]);
	});

	it('refuses a sentence, saying what is wrong with it', async () => {
		const mcp = mcpHarness();
		const message = aMessage(mcp);

		const result = await reactTool.run(mcp.deps, {
			message_id: message.id,
			emoji: 'looks good to me'
		});

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('no spaces');
	});

	it('refuses a bare word, and names the shortcodes it would take', async () => {
		const mcp = mcpHarness();
		const message = aMessage(mcp);

		const result = await reactTool.run(mcp.deps, { message_id: message.id, emoji: 'lgtm' });

		expect(result.isError).toBe(true);
		// An agent that gets this can fix it from the message alone.
		expect(toolText(result)).toContain('eyes');
	});

	it('refuses a message that is not there', async () => {
		const mcp = mcpHarness();

		const result = await reactTool.run(mcp.deps, { message_id: 'nope', emoji: '👍' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('no such message');
	});
});
