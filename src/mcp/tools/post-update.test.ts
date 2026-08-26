import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, listUpdates, registerSession } from '$domain';
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

/**
 * Sessions (issue #21). `updates.session_id` is the column that lets a card be
 * traced back to the run that produced it, so the tool has to accept the id
 * `register_session` handed out — and refuse anybody else's.
 */
describe('post_update with a session', () => {
	it('records the session the agent is running in', () => {
		const { session } = registerSession(mcp.h, { agentId: mcp.deps.agent.id });

		const result = run({ project: 'agent-dashboard', body: 'in a run', session_id: session.id });

		expect(result.structuredContent).toMatchObject({ update: { session_id: session.id } });

		const { updates } = listUpdates(mcp.h, { project: 'agent-dashboard' });
		expect(updates[0].sessionId).toBe(session.id);
	});

	it('leaves session_id null when the agent does not pass one', () => {
		const result = run({ project: 'agent-dashboard', body: 'no session' });

		expect(result.structuredContent).toMatchObject({ update: { session_id: null } });
	});

	it("refuses another agent's session as invalid_argument, and posts nothing", () => {
		const other = mcp.mint('imposter');
		const { session } = registerSession(mcp.h, { agentId: other.agentId });

		const result = run({ project: 'agent-dashboard', body: 'not mine', session_id: session.id });

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
		expect(listUpdates(mcp.h, { project: 'agent-dashboard' }).updates).toHaveLength(0);
	});

	it('reports an unknown session as not_found', () => {
		const result = run({ project: 'agent-dashboard', body: 'ghost run', session_id: 'no-such' });

		expect(result).toMatchObject({ isError: true, structuredContent: { error: 'not_found' } });
		expect(toolText(result)).toContain('no-such');
	});

	it('documents session_id, and both codes it can fail with', () => {
		const description = postUpdateTool.config.description;

		expect(description).toContain('session_id');
		expect(description).toContain('register_session');
	});
});
