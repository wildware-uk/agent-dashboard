import { describe, expect, it } from 'vitest';
import { createProject, defineTag, listTags, postUpdate, tagsForCards } from '$domain';
import { mcpHarness } from '../testing';
import { listTagsTool, tagCardTool } from './tag-card';

/**
 * `tag_card` and `list_tags` (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 */
function aCard(mcp: ReturnType<typeof mcpHarness>) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'the fee service is down'
	});
	return { project, update };
}

describe('labelling a card', () => {
	it('puts one of the project`s words on it', async () => {
		const mcp = mcpHarness();
		const { project, update } = aCard(mcp);
		defineTag(mcp.h, { project: project.slug, name: 'Bug', colour: 'rose' });

		const result = await tagCardTool.run(mcp.deps, { update_id: update.id, tag: 'bug' });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			card: { kind: 'update', id: update.id },
			tag: { name: 'Bug', colour: 'rose' },
			on: true
		});
		expect(tagsForCards(mcp.h, { update: [update.id] })).toHaveLength(1);
	});

	it('takes it off again when asked', async () => {
		const mcp = mcpHarness();
		const { project, update } = aCard(mcp);
		defineTag(mcp.h, { project: project.slug, name: 'Bug' });
		await tagCardTool.run(mcp.deps, { update_id: update.id, tag: 'bug', on: true });

		const result = await tagCardTool.run(mcp.deps, { update_id: update.id, tag: 'bug', on: false });

		expect(result.structuredContent).toMatchObject({ on: false });
		expect(tagsForCards(mcp.h, { update: [update.id] })).toEqual([]);
	});

	it('refuses a word the project has not decided, unless told to decide it', async () => {
		const mcp = mcpHarness();
		const { project, update } = aCard(mcp);

		const refused = await tagCardTool.run(mcp.deps, { update_id: update.id, tag: 'bug' });
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent).toMatchObject({ error: 'not_found' });

		const made = await tagCardTool.run(mcp.deps, {
			update_id: update.id,
			tag: 'bug',
			create: true
		});
		expect(made.isError).toBeFalsy();
		expect(listTags(mcp.h, { project: project.slug }).map((tag) => tag.name)).toEqual(['bug']);
	});

	it('refuses two cards at once, and none at all', async () => {
		const mcp = mcpHarness();
		const { update } = aCard(mcp);

		const both = await tagCardTool.run(mcp.deps, {
			update_id: update.id,
			message_id: update.id,
			tag: 'bug'
		});
		const neither = await tagCardTool.run(mcp.deps, { tag: 'bug' });

		expect(both.structuredContent).toMatchObject({ error: 'invalid_argument' });
		expect(neither.structuredContent).toMatchObject({ error: 'invalid_argument' });
	});
});

describe('reading a project`s words', () => {
	it('lists them with who decided each one', async () => {
		const mcp = mcpHarness();
		const { project } = aCard(mcp);
		defineTag(mcp.h, { project: project.slug, name: 'Bug' });
		defineTag(mcp.h, { project: project.slug, name: 'Feature', agentId: mcp.deps.agent.id });

		const result = await listTagsTool.run(mcp.deps, { project: project.slug });

		const body = result.structuredContent as {
			tags: { name: string; agent_id: string | null }[];
			count: number;
		};
		expect(body.count).toBe(2);
		expect(body.tags.map((tag) => tag.name)).toEqual(['Bug', 'Feature']);
		expect(body.tags[0].agent_id).toBeNull();
		expect(body.tags[1].agent_id).toBe(mcp.deps.agent.id);
	});

	it('says plainly when a project has decided none', async () => {
		const mcp = mcpHarness();
		const { project } = aCard(mcp);

		const result = await listTagsTool.run(mcp.deps, { project: project.slug });

		expect((result.structuredContent as { count: number }).count).toBe(0);
		expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining('No tags yet') });
	});

	it('refuses a project that does not exist', async () => {
		const mcp = mcpHarness();

		const result = await listTagsTool.run(mcp.deps, { project: 'nope' });

		expect(result.structuredContent).toMatchObject({ error: 'not_found' });
	});
});
