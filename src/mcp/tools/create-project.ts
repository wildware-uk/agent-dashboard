/**
 * `create_project` (design §5).
 *
 * Thin by construction: zod checks the shape, the domain owns the rules
 * (slugging, idempotency, the event), and `./` formats the answer. If this file
 * ever needs an `if` about what a project may be, that `if` belongs in
 * `src/domain/projects.ts`.
 */
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, SLUG_MAX_LENGTH, createProject } from '$domain';
import { z } from 'zod';
import { guard, ok, projectView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	name: z
		.string()
		.max(NAME_MAX_LENGTH)
		.describe(`Display title, e.g. "Agent Dashboard". 1-${NAME_MAX_LENGTH} characters.`),
	slug: z
		.string()
		.max(SLUG_MAX_LENGTH)
		.optional()
		.describe(
			`Short id used to refer to this project later, e.g. "agent-dashboard". ` +
				`Lowercase letters, digits and hyphens, at most ${SLUG_MAX_LENGTH} characters; ` +
				`anything else is normalised (spaces and punctuation become hyphens, capitals are ` +
				`lowered). Defaults to a slug derived from name.`
		),
	description: z
		.string()
		.max(DESCRIPTION_MAX_LENGTH)
		.optional()
		.describe(
			`One short paragraph shown under the project in the dashboard. At most ` +
				`${DESCRIPTION_MAX_LENGTH} characters.`
		)
};

export const createProjectTool: McpTool<typeof inputSchema> = {
	name: 'create_project',
	config: {
		title: 'Create a project',
		description: [
			'Create a project to post status updates into, or get back the one that already owns the slug.',
			'',
			'Idempotent on slug: calling this again with the same name or slug returns the existing',
			'project unchanged and reports created=false, so it is safe to call on every startup',
			'instead of checking first. It never overwrites an existing project, so a description',
			'passed on a repeat call is ignored.',
			'',
			'Arguments:',
			`- name (required): display title, e.g. "Agent Dashboard". 1-${NAME_MAX_LENGTH} characters.`,
			`- slug (optional): the short id to refer to this project by later, lowercase letters,`,
			`  digits and hyphens, at most ${SLUG_MAX_LENGTH} characters. Anything else is normalised.`,
			'  Defaults to a slug derived from name.',
			`- description (optional): one paragraph shown in the dashboard, at most`,
			`  ${DESCRIPTION_MAX_LENGTH} characters.`,
			'',
			'Returns { project: { id, slug, name, description, status, pinned, created_at, updated_at },',
			'created }. Pass project.slug or project.id as the "project" argument to post_update.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const { project, created } = createProject(ctx, {
				name: args.name,
				slug: args.slug,
				description: args.description
			});

			const summary = created
				? `Created project "${project.name}" (slug ${project.slug}).`
				: `Project "${project.name}" already exists (slug ${project.slug}); returning it unchanged.`;

			return ok(summary, { project: projectView(project), created });
		})
};
