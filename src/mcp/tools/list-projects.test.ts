import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, updateProject } from '$domain';
import { mcpHarness, type McpHarness } from '../testing';
import { listProjectsTool } from './list-projects';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness();
});

const run = (args: Parameters<typeof listProjectsTool.run>[1] = {}) =>
	listProjectsTool.run(mcp.deps, args);

describe('list_projects', () => {
	it('returns an empty list and a count, not an error, on a fresh deployment', () => {
		const result = run();

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({ projects: [], count: 0 });
	});

	it('lists projects in the dashboard sidebar order: pinned first', () => {
		createProject(mcp.h, { name: 'First' });
		createProject(mcp.h, { name: 'Second' });
		updateProject(mcp.h, 'second', { pinned: true });

		const result = run();

		expect(result.structuredContent).toMatchObject({ count: 2 });
		const projects = (result.structuredContent as { projects: { slug: string }[] }).projects;
		expect(projects.map((project) => project.slug)).toEqual(['second', 'first']);
	});

	it('filters by status when asked', () => {
		createProject(mcp.h, { name: 'Live' });
		createProject(mcp.h, { name: 'Old' });
		updateProject(mcp.h, 'old', { status: 'archived' });

		expect(run({ status: 'archived' }).structuredContent).toMatchObject({
			count: 1,
			projects: [{ slug: 'old' }]
		});
		expect(run({ status: 'active' }).structuredContent).toMatchObject({
			count: 1,
			projects: [{ slug: 'live' }]
		});
	});

	it('writes nothing and publishes nothing: it is a read', () => {
		createProject(mcp.h, { name: 'Live' });
		const before = mcp.h.eventNames().length;

		run();

		expect(mcp.h.eventNames()).toHaveLength(before);
	});
});
