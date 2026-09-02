import { describe, expect, it } from 'vitest';
import { createProject, listThread, postMessage, postUpdate } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { postMessageTool } from './post-message';

/**
 * `post_message` (design §5, §7) — the agent's half of a conversation.
 *
 * The gap this closed was found by using the product: the owner could reply on
 * a card and the agent had no way to answer there, so it posted a new update
 * instead, which reads as ignoring them.
 */

function anUpdate(mcp: McpHarness, body = 'shipped the thing') {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, { project: project.slug, agentId: mcp.deps.agent.id, body });
	return { project, update };
}

describe('replying where the owner asked', () => {
	it('lands in the thread on the card, not on a card of its own', async () => {
		const mcp = mcpHarness();
		const { update } = anUpdate(mcp);
		postMessage(mcp.h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'did that work?'
		});

		const result = await postMessageTool.run(mcp.deps, {
			body: 'it did — logs are clean',
			update_id: update.id
		});

		expect(result.isError).toBeFalsy();
		const thread = listThread(mcp.h, { updateId: update.id });
		expect(thread.map((message) => message.body)).toEqual([
			'did that work?',
			'it did — logs are clean'
		]);
	});

	it('writes as the agent holding the token, never as anybody else', async () => {
		const mcp = mcpHarness();
		const { update } = anUpdate(mcp);

		await postMessageTool.run(mcp.deps, { body: 'mine', update_id: update.id });

		const [message] = listThread(mcp.h, { updateId: update.id });
		// There is no author argument at all, so this is the only value it can be.
		expect(message?.author).toBe(`agent:${mcp.deps.agent.id}`);
	});

	it('announces it, so the owner’s open tab shows it without a reload', async () => {
		const mcp = mcpHarness();
		const { update } = anUpdate(mcp);

		await postMessageTool.run(mcp.deps, { body: 'live', update_id: update.id });

		expect(mcp.h.events.map((event) => event.type)).toContain('message.created');
	});

	it('replies on a task as readily as on a card', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const { createTask } = await import('$domain');
		const task = createTask(mcp.h, { project: project.slug, title: 'ship it' });

		const result = await postMessageTool.run(mcp.deps, {
			body: 'picked this up',
			task_id: task.id
		});

		expect(result.isError).toBeFalsy();
		expect(listThread(mcp.h, { taskId: task.id }).map((m) => m.body)).toEqual(['picked this up']);
	});

	it('says plainly that it landed, because that is what the model reads', async () => {
		const mcp = mcpHarness();
		const { update } = anUpdate(mcp);

		const result = await postMessageTool.run(mcp.deps, { body: 'ok', update_id: update.id });

		expect(toolText(result)).toContain('Replied');
	});
});

describe('what it refuses', () => {
	it('refuses a message anchored to both an update and a task', async () => {
		const mcp = mcpHarness();
		const { project, update } = anUpdate(mcp);
		const { createTask } = await import('$domain');
		const task = createTask(mcp.h, { project: project.slug, title: 'ship it' });

		const result = await postMessageTool.run(mcp.deps, {
			body: 'which thread is this?',
			update_id: update.id,
			task_id: task.id
		});

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('not both');
	});

	it('refuses an empty body rather than posting a blank line', async () => {
		const mcp = mcpHarness();
		const { update } = anUpdate(mcp);

		const result = await postMessageTool.run(mcp.deps, { body: '   ', update_id: update.id });

		expect(result.isError).toBe(true);
	});

	it('refuses an update that does not exist, rather than filing it elsewhere', async () => {
		const mcp = mcpHarness();

		const result = await postMessageTool.run(mcp.deps, {
			body: 'into the void',
			update_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ'
		});

		expect(result.isError).toBe(true);
	});
});
