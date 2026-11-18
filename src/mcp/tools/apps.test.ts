import { describe, expect, it } from 'vitest';
import { appsOn, createProject } from '$domain';
import { mcpHarness, toolText } from '../testing';
import { listAppsTool } from './list-apps';
import { registerAppTool } from './register-app';
import { setAppDataTool } from './set-app-data';
import { postUpdateTool } from './post-update';

/**
 * `register_app`, `list_apps` and `set_app_data` (migration 041).
 *
 * The owner: "I want apps to be able to embed UI directly into the dashboard."
 * The three tools are that sentence — ship an interface, see what is shipped,
 * and keep it current — and this is the journey an agent actually makes.
 */
const HTML = '<!doctype html><title>Board</title><p id="root">…';

function harnessWithProject() {
	const mcp = mcpHarness();
	const { project } = createProject(mcp.h, { name: 'Agent Dashboard' });
	return { mcp, slug: project.slug };
}

function register(mcp: ReturnType<typeof mcpHarness>, overrides: Record<string, unknown> = {}) {
	return registerAppTool.run(mcp.deps, {
		uri: 'ui://review-board',
		name: 'Review board',
		html: HTML,
		...overrides
	} as Parameters<typeof registerAppTool.run>[1]);
}

describe('registering an app', () => {
	it('stores it and says how to show one', () => {
		const { mcp } = harnessWithProject();

		const result = register(mcp);

		expect(result.isError).toBeUndefined();
		expect(toolText(result)).toContain('apps: [{ app: "ui://review-board"');
		expect(result.structuredContent).toMatchObject({
			uri: 'ui://review-board',
			name: 'Review board',
			csp: { connect: [], resource: [], frame: [] }
		});
	});

	it('refuses a handle that is not a ui:// URI', () => {
		const { mcp } = harnessWithProject();

		const result = register(mcp, { uri: 'https://example.com/board' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('ui://');
	});

	it('will not let one agent replace another agent’s app', () => {
		const { mcp } = harnessWithProject();
		register(mcp);

		const other = mcp.mint('rover');
		const result = registerAppTool.run(
			{ ctx: mcp.h, agent: { id: other.agentId, name: 'rover' } as never },
			{ uri: 'ui://review-board', name: 'Mine', html: HTML } as never
		);

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('another agent');
	});
});

describe('listing them', () => {
	it('says which are the caller’s own', () => {
		const { mcp } = harnessWithProject();
		register(mcp);

		const { apps } = listAppsTool.run(mcp.deps, {}).structuredContent as {
			apps: { uri: string; mine: boolean }[];
		};

		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({ uri: 'ui://review-board', mine: true });
	});
});

describe('showing one on a card', () => {
	it('posts it and hands back the id to push data into', () => {
		const { mcp, slug } = harnessWithProject();
		register(mcp);

		const posted = postUpdateTool.run(mcp.deps, {
			project: slug,
			body: 'three to review',
			apps: [{ app: 'ui://review-board', data: { open: 3 }, title: '3 to review' }]
		} as never);

		const { apps } = posted.structuredContent as {
			apps: { view_id: string; uri: string; title: string }[];
		};
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({ uri: 'ui://review-board', title: '3 to review' });

		const updated = setAppDataTool.run(mcp.deps, {
			view_id: apps[0].view_id,
			data: { open: 1 }
		} as never);

		expect(updated.isError).toBeUndefined();
		const update = (posted.structuredContent as { update: { id: string } }).update;
		expect(appsOn(mcp.h, { kind: 'update', id: update.id })[0].data).toEqual({ open: 1 });
	});

	it('fails the whole post when the app is not registered', () => {
		const { mcp, slug } = harnessWithProject();

		const result = postUpdateTool.run(mcp.deps, {
			project: slug,
			body: 'three to review',
			apps: [{ app: 'ui://nope' }]
		} as never);

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('register_app');
	});

	it('refuses to push data into a showing that does not exist', () => {
		const { mcp } = harnessWithProject();

		const result = setAppDataTool.run(mcp.deps, { view_id: 'nothing', data: {} } as never);

		expect(result.isError).toBe(true);
	});
});
