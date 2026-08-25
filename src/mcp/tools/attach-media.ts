/**
 * `attach_media` (design §5, §6) — for media that lands after the update.
 *
 * `post_update` already takes `media_ids`, so this tool exists for the case the
 * two-step upload creates: an agent that has posted, and then finished uploading
 * a video. Rather than making it re-post, it attaches.
 *
 * The tool is **forgiving on purpose**. Ids that were not the caller's to attach,
 * or that some other update already claimed, come back in `skipped` instead of
 * failing the call, because the most likely reason an agent calls this twice is
 * that the first call succeeded and the answer was lost. `post_update` takes the
 * opposite line — a bad `media_ids` fails the whole post — because there the
 * agent is still deciding what to publish.
 */
import { MEDIA_PER_UPDATE_MAX, attachMedia } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	update_id: z
		.string()
		.describe(
			'The 26-character id of the update to attach to, as returned by post_update. The update ' +
				'must still exist and must not have been deleted.'
		),
	media_ids: z
		.array(z.string())
		.min(1)
		.max(MEDIA_PER_UPDATE_MAX)
		.describe(
			`Ids from create_upload whose bytes you have already PUT, at most ` +
				`${MEDIA_PER_UPDATE_MAX}. Ids that are not yours, or that are already on another ` +
				`update, come back as skipped rather than failing the call.`
		)
};

export const attachMediaTool: McpTool<typeof inputSchema> = {
	name: 'attach_media',
	config: {
		title: 'Attach media to an update',
		description: [
			'Attach already-uploaded media to an update you have already posted. Use this when the',
			'upload finished after the post — for a video, say — and post_update could not carry the',
			'ids at the time.',
			'',
			'Arguments:',
			'- update_id (required): the 26-character id post_update returned.',
			`- media_ids (required): one to ${MEDIA_PER_UPDATE_MAX} ids from create_upload whose bytes`,
			'  you have already PUT to their upload_url.',
			'',
			'Safe to retry: attaching the same id twice is not an error. Ids you do not own, and ids',
			'already attached to another update, are reported in skipped and change nothing.',
			'',
			'Returns { update_id, attached, skipped }. On failure: error "not_found" means the update',
			'does not exist or has been deleted, and "invalid_argument" means the list was empty, too',
			'long, or contained something that is not an id.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const result = attachMedia(ctx, {
				updateId: args.update_id,
				mediaIds: args.media_ids,
				// Identity comes from the token, never from `args` (design §5), which
				// is what stops one agent decorating its post with another's media.
				agentId: agent.id
			});

			const summary =
				result.skipped.length === 0
					? `Attached ${result.attached.length} media to update ${args.update_id}.`
					: `Attached ${result.attached.length} media to update ${args.update_id}; ` +
						`skipped ${result.skipped.length} that were not available to you.`;

			return ok(summary, {
				update_id: args.update_id,
				attached: result.attached,
				skipped: result.skipped
			});
		})
};
