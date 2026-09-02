/**
 * `set_project_theme` (design §7) — an agent brands its own project.
 *
 * The reason an agent may do this at all: a project is created by an agent
 * (`create_project`), and a fleet that sets up its own board should be able to
 * make it recognisable — the owner glancing at a phone benefits from "the amber
 * one is the build fleet" long before they read a word.
 *
 * The colours are checked in `$domain` against a hex pattern and nothing else,
 * because they end up in a CSS custom property on the owner's dashboard. That is
 * stated in the description below too: an agent that knows `red` will be refused
 * is an agent that sends `#ff0000` the first time.
 *
 * The logo is a media id from `create_upload`, not a URL. An external URL would
 * be a request the owner's browser makes to somewhere this deployment does not
 * control, on every page load.
 */
import { updateProject } from '$domain';
import { z } from 'zod';
import { guard, ok, projectView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	project: z
		.string()
		.describe(
			'Which project to style: its slug ("agent-dashboard") or its 26-character id, as ' +
				'create_project and list_projects return.'
		),
	background: z
		.string()
		.nullable()
		.optional()
		.describe(
			'The page background, as a hex colour: "#101820" or "#182" both work. Named colours, ' +
				'rgb() and anything else are refused. Omit to leave it; pass null to clear it. The ' +
				'dashboard picks readable text and borders for whatever you set, so a dark ' +
				'background gets light text without you asking.'
		),
	accent: z
		.string()
		.nullable()
		.optional()
		.describe(
			'The colour of buttons and links, as a hex colour. Same rules as background. Omit to ' +
				'leave it; pass null to clear it.'
		),
	logo_replaces_name: z
		.boolean()
		.nullable()
		.optional()
		.describe(
			'True to show the logo INSTEAD of the project name, for a logo that is the name — a ' +
				'wordmark. The name is still read by screen readers as the image\u2019s alt text. ' +
				'Needs a logo: setting this without one is refused. Omit to leave it; false or null ' +
				'shows both.'
		),
	logo_media_id: z
		.string()
		.nullable()
		.optional()
		.describe(
			'An image to show beside the project name: a media id from create_upload whose bytes ' +
				'you have already PUT and which has finished processing. It must be an image, not ' +
				'a video. Omit to leave it; pass null to remove it.'
		)
};

export const setProjectThemeTool: McpTool<typeof inputSchema> = {
	name: 'set_project_theme',
	config: {
		title: 'Style a project',
		description: [
			"Give a project its own look on your owner's dashboard: a background colour, an accent",
			'colour for buttons and links, and a logo beside its name. Use it to make a board you',
			'created recognisable at a glance.',
			'',
			'Arguments:',
			'- project (required): the slug or the 26-character id.',
			'- background (optional): hex colour for the page, e.g. "#101820".',
			'- accent (optional): hex colour for buttons and links.',
			'- logo_media_id (optional): a ready image from create_upload.',
			'- logo_replaces_name (optional): true to show the logo instead of the name.',
			'',
			'COLOURS MUST BE HEX. "#101820" and "#182" are accepted; "red", "rgb(1,2,3)" and',
			'"var(--x)" are refused, because these values become CSS on the dashboard and it will',
			'not take anything it cannot check. You do not need to pick a text',
			'colour: readable text, borders and raised surfaces are derived from your background.',
			'',
			'Each field is merged with what the project already has, so setting an accent leaves an',
			'existing logo alone. Pass null for a field to clear just that one. Every open tab',
			'restyles without a reload.',
			'',
			'Returns { project: { id, slug, name, description, status, pinned, created_at,',
			'updated_at, theme } }.',
			'',
			'On failure: "not_found" means the project reference matched nothing, or the logo id has',
			'no media behind it. "invalid_argument" means a colour was not a hex literal, the logo',
			'is a video, or its bytes have not finished processing yet — try again once the upload',
			'has been derived. Nothing is written when either happens.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const theme: {
				background?: string | null;
				accent?: string | null;
				logoMediaId?: string | null;
				logoReplacesName?: boolean | null;
			} = {};
			if (args.background !== undefined) theme.background = args.background;
			if (args.accent !== undefined) theme.accent = args.accent;
			if (args.logo_media_id !== undefined) theme.logoMediaId = args.logo_media_id;
			if (args.logo_replaces_name !== undefined) {
				theme.logoReplacesName = args.logo_replaces_name;
			}

			const project = updateProject(ctx, args.project, { theme });

			return ok(`Styled project ${project.slug}.`, { project: projectView(project) });
		})
};
