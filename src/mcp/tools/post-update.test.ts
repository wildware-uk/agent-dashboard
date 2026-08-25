import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listUpdates } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { postUpdateTool } from './post-update';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	createProject(mcp.h, { name: 'Agent Dashboard' });
	mcp.h.events.length = 0;
});

const run = (args: Parameters<typeof postUpdateTool.run>[1]) => postUpdateTool.run(mcp.deps, args);

describe('post_update', () => {
	it('stores the update, attributes it to the token holder, and publishes once', () => {
		const result = run({
			project: 'agent-dashboard',
			body: '# shipped',
			title: 'v0.1',
			level: 'success'
		});

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			update: {
				agent_id: mcp.deps.agent.id,
				level: 'success',
				title: 'v0.1',
				body_chars: 9,
				session_id: null
			}
		});
		expect(mcp.h.eventNames()).toEqual(['update.created']);

		const { updates } = listUpdates(mcp.h, { project: 'agent-dashboard' });
		expect(updates).toHaveLength(1);
		expect(updates[0].body).toBe('# shipped');
		expect(updates[0].agentId).toBe(mcp.deps.agent.id);
	});

	it('accepts a project id as well as a slug', () => {
		const { updates } = listUpdates(mcp.h);
		expect(updates).toHaveLength(0);

		const project = createProject(mcp.h, { name: 'Other' }).project;
		const result = run({ project: project.id, body: 'by id' });

		expect(result.structuredContent).toMatchObject({ update: { project_id: project.id } });
	});

	it('defaults the level to info', () => {
		const result = run({ project: 'agent-dashboard', body: 'plain note' });

		expect(result.structuredContent).toMatchObject({ update: { level: 'info', title: null } });
	});

	it('names the agent it posted as, so the caller can see whose token it used', () => {
		const result = run({ project: 'agent-dashboard', body: 'plain note' });

		expect(toolText(result)).toContain('scout');
	});

	it('reports an unknown project as not_found rather than throwing', () => {
		const result = run({ project: 'no-such-project', body: 'hello' });

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
		expect(toolText(result)).toContain('no-such-project');
		expect(mcp.h.eventNames()).toEqual([]);
	});

	it('reports a blank body as invalid_argument', () => {
		expect(run({ project: 'agent-dashboard', body: '   ' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
	});

	it('cannot post as another agent: identity comes from the deps, not the arguments', () => {
		const other = mcp.mint('imposter');

		run({ project: 'agent-dashboard', body: 'mine' });

		const { updates } = listUpdates(mcp.h, { project: 'agent-dashboard' });
		expect(updates[0].agentId).toBe(mcp.deps.agent.id);
		expect(updates[0].agentId).not.toBe(other.agentId);
	});
});
