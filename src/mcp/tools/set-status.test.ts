import { describe, expect, it } from 'vitest';
import { createProject, postMessage, postUpdate, resolveCard } from '$domain';
import { mcpHarness } from '../testing';
import { setStatusTool } from './set-status';

/**
 * `set_status` (migration 035) — the five task tools, replaced by one.
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card."
 */
function aCard(mcp: ReturnType<typeof mcpHarness>) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'deploy the fee service'
	});
	return { project, update };
}

describe('marking a card as work', () => {
	it('marks an update, and says so back', async () => {
		const mcp = mcpHarness();
		const { update } = aCard(mcp);

		const result = await setStatusTool.run(mcp.deps, {
			update_id: update.id,
			status: 'in_progress'
		});

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			card: { kind: 'update', id: update.id },
			status: 'in_progress'
		});
		expect(resolveCard(mcp.h, { kind: 'update', id: update.id }).status).toBe('in_progress');
	});

	it('marks the owner`s own post, which is how they ask for work', async () => {
		const mcp = mcpHarness();
		const { project } = aCard(mcp);
		const post = postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'deploy it please'
		});

		await setStatusTool.run(mcp.deps, { message_id: post.id, status: 'in_progress' });

		expect(resolveCard(mcp.h, { kind: 'message', id: post.id }).status).toBe('in_progress');
	});

	it('takes the mark off, leaving an ordinary card', async () => {
		const mcp = mcpHarness();
		const { update } = aCard(mcp);
		await setStatusTool.run(mcp.deps, { update_id: update.id, status: 'todo' });

		const result = await setStatusTool.run(mcp.deps, { update_id: update.id, status: null });

		expect(result.structuredContent).toMatchObject({ status: null });
	});

	it('refuses a card that is not there, and a call naming two', async () => {
		const mcp = mcpHarness();
		const { update } = aCard(mcp);

		expect(await setStatusTool.run(mcp.deps, { update_id: 'nope', status: 'todo' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
		expect(
			await setStatusTool.run(mcp.deps, {
				update_id: update.id,
				message_id: 'm1',
				status: 'todo'
			})
		).toMatchObject({ isError: true, structuredContent: { error: 'invalid_argument' } });
	});

	it('lets another agent move it, because work is shared', async () => {
		const mcp = mcpHarness({ name: 'scout' });
		const { update } = aCard(mcp);
		const otherId = mcp.mint('other').agentId;

		const result = await setStatusTool.run(
			{ ...mcp.deps, agent: { ...mcp.deps.agent, id: otherId } },
			{ update_id: update.id, status: 'blocked' }
		);

		// Unlike editing, which is only ever your own words: a state only the
		// author could change would be a board with one person allowed to move the
		// cards.
		expect(result.isError).toBeFalsy();
		expect(resolveCard(mcp.h, { kind: 'update', id: update.id }).status).toBe('blocked');
	});
});
