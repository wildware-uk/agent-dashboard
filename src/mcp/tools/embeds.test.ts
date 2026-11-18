import { describe, expect, it } from 'vitest';
import { createProject, listUpdateEmbeds, postUpdate } from '$domain';
import { mcpHarness, toolText } from '../testing';
import { listEmbedTypesTool, placeholdersIn } from './list-embed-types';
import { registerEmbedTypeTool } from './register-embed-type';

/**
 * `register_embed_type` and `list_embed_types` (migration 027).
 *
 * The owner asked for embeds that are "dynamic and registered by the agents",
 * with a few shipped as defaults. These two tools are that sentence: listing
 * says what already exists, registering adds to it, and the pair is what stops
 * every agent inventing its own near-copy of `slack-message`.
 */
const A_SPEC = {
	theme: { accent: '#0969da' },
	chrome: { label: 'Linear' },
	blocks: [
		{ type: 'header', title: '{{title}}', subtitle: '{{team}}' },
		{ type: 'markdown', value: '{{body}}' }
	]
};

describe('listing the looks', () => {
	it('names the five that ship, and what each one reads', () => {
		const mcp = mcpHarness();

		const result = listEmbedTypesTool.run(mcp.deps, {});
		const { types } = result.structuredContent as {
			types: { slug: string; built_in: boolean; fields: string[] }[];
		};

		expect(types.map((type) => type.slug)).toContain('slack-message');
		expect(types.every((type) => type.built_in)).toBe(true);

		// The values an agent has to send are read off the spec rather than
		// documented separately, so they cannot drift from it.
		const slack = types.find((type) => type.slug === 'slack-message')!;
		expect(slack.fields).toEqual(
			expect.arrayContaining(['avatar', 'username', 'channel', 'time', 'text'])
		);
	});

	it('finds every placeholder a spec mentions, wherever it is', () => {
		expect(
			placeholdersIn({
				theme: {},
				chrome: { label: '{{site}}' },
				frame: {},
				blocks: [
					{ type: 'fields', items: [{ label: 'Status', value: '{{status}}' }] },
					{ type: 'footer', url: '{{ url }}' }
				]
			})
		).toEqual(['site', 'status', 'url']);
	});
});

describe('registering a look', () => {
	it('adds one an agent can then post in', () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });

		const result = registerEmbedTypeTool.run(mcp.deps, {
			slug: 'linear-issue',
			name: 'Linear issue',
			spec: A_SPEC
		});

		expect(result.isError).toBeFalsy();
		expect(toolText(result)).toContain('linear-issue');

		const update = postUpdate(mcp.h, {
			project: project.slug,
			agentId: mcp.deps.agent.id,
			body: 'picked this up',
			embeds: [{ type: 'linear-issue', data: { title: 'Fix the banner', team: 'Web' } }]
		});

		expect(listUpdateEmbeds(mcp.h, [update.id])[update.id][0].type).toBe('linear-issue');
	});

	it('reports a spec that is not one as an argument the agent can fix', () => {
		const mcp = mcpHarness();

		const result = registerEmbedTypeTool.run(mcp.deps, {
			slug: 'bad',
			name: 'Bad',
			spec: { blocks: [{ type: 'script', value: 'alert(1)' }] }
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'invalid_argument' });
	});

	it('refuses to redefine a look the dashboard ships, and says what to do', () => {
		const mcp = mcpHarness();

		const result = registerEmbedTypeTool.run(mcp.deps, {
			slug: 'slack-message',
			name: 'Mine now',
			spec: A_SPEC
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'conflict' });
		expect(toolText(result)).toContain('different slug');
	});
});
