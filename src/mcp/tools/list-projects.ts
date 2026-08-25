/**
 * `list_projects` (design §5).
 *
 * A read: nothing is written and nothing is published. The order is the domain's
 * (pinned first, then newest), because it is the order the dashboard sidebar
 * shows, and an agent quoting "the first project" should mean the same thing the
 * owner sees.
 */
import { listProjects } from '$domain';
import { z } from 'zod';
import { guard, ok, projectView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	status: z
		.enum(['active', 'archived'])
		.optional()
		.describe('Filter by lifecycle state. Omit to get both active and archived projects.')
};

export const listProjectsTool: McpTool<typeof inputSchema> = {
	name: 'list_projects',
	config: {
		title: 'List projects',
		description: [
			"List the dashboard's projects, pinned first and then newest — the order the owner sees",
			'them in the sidebar. Call this to find the slug to post an update into.',
			'',
			'Arguments:',
			'- status (optional): "active" or "archived". Omit to get both.',
			'',
			'Returns { projects: [{ id, slug, name, description, status, pinned, created_at,',
			'updated_at }], count }. An empty list is a normal answer, not an error: use',
			'create_project first.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const projects = listProjects(ctx, { status: args.status });
			const summary =
				projects.length === 0
					? 'No projects yet. Create one with create_project.'
					: `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects
							.map((project) => project.slug)
							.join(', ')}.`;

			return ok(summary, { projects: projects.map(projectView), count: projects.length });
		})
};
