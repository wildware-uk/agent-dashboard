import { beforeEach, describe, expect, it } from 'vitest';
import { listProjects } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { createProjectTool } from './create-project';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness();
});

const run = (args: Parameters<typeof createProjectTool.run>[1]) =>
	createProjectTool.run(mcp.deps, args);

describe('create_project', () => {
	it('creates the project and reports it as created', () => {
		const result = run({ name: 'Agent Dashboard', description: 'the status wall' });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			created: true,
			project: {
				slug: 'agent-dashboard',
				name: 'Agent Dashboard',
				description: 'the status wall',
				status: 'active'
			}
		});
		expect(toolText(result)).toContain('Created project');
		expect(listProjects(mcp.h)).toHaveLength(1);
		expect(mcp.h.eventNames()).toEqual(['project.created']);
	});

	it('honours an explicit slug', () => {
		const result = run({ name: 'The Feed', slug: 'feed' });

		expect(result.structuredContent).toMatchObject({ project: { slug: 'feed' } });
	});

	it('is idempotent: the second call returns the same project and created=false', () => {
		run({ name: 'Agent Dashboard' });
		const again = run({ name: 'Agent Dashboard', description: 'ignored on the repeat' });

		expect(again.isError).toBeUndefined();
		expect(again.structuredContent).toMatchObject({
			created: false,
			project: { slug: 'agent-dashboard', description: null }
		});
		expect(toolText(again)).toContain('already exists');
		expect(listProjects(mcp.h)).toHaveLength(1);
		// A create that created nothing announces nothing.
		expect(mcp.h.eventNames()).toEqual(['project.created']);
	});

	it('reports a domain refusal as a tool error with the code, not a crash', () => {
		const result = run({ name: '   ' });

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
	});
});
