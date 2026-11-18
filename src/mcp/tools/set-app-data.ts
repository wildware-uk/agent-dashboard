/**
 * `set_app_data` (migration 041) — the app on the card is live.
 *
 * This is the difference between an interface and a screenshot of one: the agent
 * that put a build board on a card pushes the next build into it, the frame
 * hears `ui/notifications/tool-result`, and every open tab redraws without the
 * owner touching anything.
 *
 * What the *app* saved for itself is untouched — the two directions are separate
 * columns precisely so that fresh numbers cannot wipe out a half-filled form.
 */
import { APP_DATA_MAX_LENGTH, APP_TITLE_MAX_LENGTH, setAppData } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	view_id: z
		.string()
		.describe('The showing to update: the id post_update or post_message returned under `apps`.'),
	data: z
		.record(z.string(), z.unknown())
		.describe('The values the app should render now. Replaces what it was given before.'),
	title: z
		.string()
		.max(APP_TITLE_MAX_LENGTH)
		.optional()
		.describe('Optional: change the line above the frame too.')
};

export const setAppDataTool: McpTool<typeof inputSchema> = {
	name: 'set_app_data',
	config: {
		title: 'Update an app on a card',
		description: [
			"Push fresh values into an app already on a card. The frame hears the spec's",
			'ui/notifications/tool-result and redraws in every open tab, with no reload and no new',
			'card — which is what makes an app worth posting rather than a screenshot of one.',
			'',
			'Use it for the thing that is still moving: the build that just went green, the two',
			'files left to review, the queue that is down to one.',
			'',
			'What the app saved for itself — the open tab, the half-filled form — is left alone.',
			'Those are separate on purpose, so your numbers cannot wipe out what your owner is in',
			'the middle of.',
			'',
			'Arguments:',
			"- view_id (required): the id the post returned under `apps`, not the app's ui:// URI.",
			`- data (required): a JSON object, at most ${APP_DATA_MAX_LENGTH} characters serialised.`,
			'  It REPLACES the previous data rather than merging into it.',
			'- title (optional): change the line above the frame.',
			'',
			'Anyone may update a showing, not only whoever posted it: what an app displays is a fact',
			'about the work, the way a field on a card is.',
			'',
			'Returns { view_id, uri, title, updated_at }. On failure: "not_found" means no showing',
			'has that id, or its card was deleted; "invalid_argument" means the data was not a JSON',
			'object, or was too big.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const view = setAppData(ctx, {
				viewId: args.view_id,
				data: args.data,
				title: args.title
			});

			return ok(`Updated the "${view.uri}" app on that card.`, {
				view_id: view.id,
				uri: view.uri,
				title: view.title,
				updated_at: view.updatedAt
			});
		})
};
