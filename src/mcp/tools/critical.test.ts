import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listUpdates } from '$domain';
import { mcpHarness, type McpHarness } from '../testing';
import { editUpdateTool } from './edit-update';
import { postUpdateTool } from './post-update';
import { requestInputTool } from './request-input';
import { CRITICAL_PRIORITY } from './priority';

let mcp: McpHarness;

beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	createProject(mcp.h, { name: 'Agent Dashboard' });
});

describe('critical priority', () => {
	it('is what pages the owner, and every tool that takes a priority says so plainly', () => {
		expect(CRITICAL_PRIORITY).toBe(
			"critical: pages the owner's phones, breaking through Do Not Disturb. Use only when the " +
				'owner explicitly asked to be paged, or for an emergency that cannot wait until ' +
				'morning. Never for routine questions, finished work or failures that can wait.'
		);
		for (const tool of [postUpdateTool, editUpdateTool, requestInputTool]) {
			const priority = (tool.config.inputSchema as Record<string, { description?: string }>)
				.priority;
			expect(priority?.description, tool.name).toContain(CRITICAL_PRIORITY);
			expect(tool.config.description, tool.name).toContain('critical');
		}
	});

	it('can be posted on an update', () => {
		const result = postUpdateTool.run(mcp.deps, {
			project: 'agent-dashboard',
			body: 'production is down',
			priority: 'critical'
		});
		expect(result.isError).toBeUndefined();
		expect(listUpdates(mcp.h, { project: 'agent-dashboard' }).updates[0].priority).toBe('critical');
	});
});
