import { describe, expect, it } from 'vitest';
import { createProject, postMessage, postUpdate, setStatus } from '$domain';
import { mcpHarness } from '../testing';
import { listWorkTool } from './list-work';

/**
 * `list_work` — asking what is being worked on, and in what state.
 *
 * The owner: "allow agents to filter cards by work status, ie get all cards in
 * project x that are status y."
 */
function aProject(mcp: ReturnType<typeof mcpHarness>, name = 'Dashboard') {
	return createProject(mcp.h, { name }).project;
}

function anUpdate(mcp: ReturnType<typeof mcpHarness>, slug: string, body: string) {
	return postUpdate(mcp.h, { project: slug, agentId: mcp.deps.agent.id, body });
}

type Work = {
	work: { id: string; kind: string; status: string; summary: string }[];
	count: number;
};

describe('listing work', () => {
	it('gives back the cards in the state that was asked for', async () => {
		const mcp = mcpHarness();
		const project = aProject(mcp);
		const stuck = anUpdate(mcp, project.slug, 'deploy is stuck on a review');
		const going = anUpdate(mcp, project.slug, 'rewriting the fee curve');
		setStatus(mcp.h, { card: { kind: 'update', id: stuck.id }, status: 'blocked' });
		setStatus(mcp.h, { card: { kind: 'update', id: going.id }, status: 'in_progress' });

		const result = await listWorkTool.run(mcp.deps, { project: project.slug, status: ['blocked'] });

		expect(result.isError).toBeFalsy();
		const body = result.structuredContent as Work;
		expect(body.count).toBe(1);
		expect(body.work[0]).toMatchObject({ kind: 'update', id: stuck.id, status: 'blocked' });
		expect(body.work[0].summary).toBe('deploy is stuck on a review');
	});

	it('finds the owner`s own posts, which is how they ask for work', async () => {
		const mcp = mcpHarness();
		const project = aProject(mcp);
		const asked = postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'please look at the portfolio rounding'
		});
		setStatus(mcp.h, { card: { kind: 'message', id: asked.id }, status: 'todo' });

		const result = await listWorkTool.run(mcp.deps, { status: ['todo'] });

		expect((result.structuredContent as Work).work[0]).toMatchObject({
			kind: 'message',
			id: asked.id,
			status: 'todo'
		});
	});

	it('says what it found, in words, so a reader need not count', async () => {
		const mcp = mcpHarness();
		const project = aProject(mcp);
		const one = anUpdate(mcp, project.slug, 'one');
		setStatus(mcp.h, { card: { kind: 'update', id: one.id }, status: 'blocked' });

		const result = await listWorkTool.run(mcp.deps, {});

		expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining('1 blocked') });
	});

	it('answers plainly when nothing matches', async () => {
		const mcp = mcpHarness();
		aProject(mcp);

		const result = await listWorkTool.run(mcp.deps, { status: ['cancelled'] });

		expect(result.isError).toBeFalsy();
		expect((result.structuredContent as Work).count).toBe(0);
		expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining('No work matches') });
	});

	it('refuses a project that does not exist', async () => {
		const mcp = mcpHarness();

		const result = await listWorkTool.run(mcp.deps, { project: 'nope' });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'not_found' });
	});

	it('stops at the limit it was given', async () => {
		const mcp = mcpHarness();
		const project = aProject(mcp);
		for (const body of ['a', 'b', 'c']) {
			const update = anUpdate(mcp, project.slug, body);
			setStatus(mcp.h, { card: { kind: 'update', id: update.id }, status: 'todo' });
		}

		const result = await listWorkTool.run(mcp.deps, { limit: 2 });

		expect((result.structuredContent as Work).count).toBe(2);
	});
});
