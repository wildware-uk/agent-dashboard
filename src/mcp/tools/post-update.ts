/**
 * `post_update` (design §5) — the tool the product exists for.
 *
 * The agent is `deps.agent`, resolved from the bearer token by `../auth.ts`.
 * There is no argument for it and no way to reach for another one, which is the
 * whole of §5's "one agent cannot post as another".
 *
 * `media_ids` is here because the upload slice is (design §6): the ids come from
 * `create_upload`, and a bad one fails the whole post rather than quietly
 * dropping an image the agent believes it published. Media whose bytes land
 * *after* the post is `attach_media`'s job instead.
 *
 * `session_id` is absent on purpose: sessions (§4) are a later slice, and an
 * argument that is accepted and then ignored is worse documentation than an
 * argument that is not there yet.
 */
import { BODY_MAX_LENGTH, MEDIA_PER_UPDATE_MAX, TITLE_MAX_LENGTH, postUpdate } from '$domain';
import { z } from 'zod';
import { guard, ok, updateView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	project: z
		.string()
		.describe(
			'Which project to post into: either its slug ("agent-dashboard") or its 26-character ' +
				'id, both as returned by create_project and list_projects.'
		),
	body: z
		.string()
		.max(BODY_MAX_LENGTH)
		.describe(
			`The update itself, as markdown, at most ${BODY_MAX_LENGTH} characters. Headings, ` +
				`lists, links and fenced code blocks all render. Raw HTML does not: it is shown as ` +
				`text, never executed.`
		),
	title: z
		.string()
		.max(TITLE_MAX_LENGTH)
		.optional()
		.describe(
			`Optional headline shown above the body, at most ${TITLE_MAX_LENGTH} characters. ` +
				`Omit for a body-only note.`
		),
	level: z
		.enum(['info', 'success', 'warn', 'error'])
		.optional()
		.describe(
			'How the dashboard colours the card: "info" (the default) for progress, "success" for ' +
				'something finished, "warn" for something the owner should look at, "error" for a ' +
				'failure you are stuck on.'
		),
	media_ids: z
		.array(z.string())
		.max(MEDIA_PER_UPDATE_MAX)
		.optional()
		.describe(
			`Images or video to show on the card: ids from create_upload whose bytes you have ` +
				`already PUT, at most ${MEDIA_PER_UPDATE_MAX}. All of them must be yours and unused, ` +
				`or the whole post is refused — nothing is published half-illustrated. If an upload ` +
				`finishes after you post, use attach_media instead.`
		),
	session_id: z
		.string()
		.optional()
		.describe(
			'Optional: the session_id register_session gave you, recorded on the update so this ' +
				'post can be traced back to the run that made it. Must be one of your own sessions. ' +
				'Omit it if you never registered one.'
		)
};

export const postUpdateTool: McpTool<typeof inputSchema> = {
	name: 'post_update',
	config: {
		title: 'Post a status update',
		description: [
			"Post a status update to a project's timeline. The owner sees it appear live, with no",
			'reload, so this is how you report progress, ask for eyes on something, or record a',
			'failure.',
			'',
			'Arguments:',
			'- project (required): the project slug ("agent-dashboard") or its 26-character id, from',
			'  create_project or list_projects.',
			`- body (required): the update as markdown, at most ${BODY_MAX_LENGTH} characters. Raw`,
			'  HTML is shown as text, never executed.',
			`- title (optional): a headline, at most ${TITLE_MAX_LENGTH} characters.`,
			'- level (optional): "info" (default), "success", "warn" or "error". The dashboard colours',
			'  the card by level, so use "error" only for something you want looked at.',
			`- media_ids (optional): up to ${MEDIA_PER_UPDATE_MAX} ids from create_upload whose bytes`,
			'  you have already uploaded. They appear as images or video on the card.',
			'- session_id (optional): the id register_session returned, if you have one. The update is',
			'  filed against that run, so the owner can see which session produced it. It must be one',
			'  of your own sessions.',
			'',
			'The posting agent is taken from your bearer token; there is deliberately no argument for',
			'it, so you can only ever post as yourself.',
			'',
			'Returns { update: { id, project_id, agent_id, session_id, title, level, pinned,',
			'body_chars, created_at } }. `session_id` is what you passed, or null if you passed',
			'nothing.',
			'',
			'On failure: error "not_found" means a reference matched nothing — the project (call',
			'list_projects), a media id (nothing was uploaded under it), or the session (it was never',
			'registered, so register_session again). "invalid_argument" means an argument was empty,',
			'too long, named media that is not yours to attach, or named a session belonging to',
			'another agent. Nothing is posted when either happens.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const update = postUpdate(ctx, {
				project: args.project,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				body: args.body,
				title: args.title,
				level: args.level,
				sessionId: args.session_id,
				mediaIds: args.media_ids
			});

			return ok(
				`Posted a ${update.level} update to project ${args.project} as agent "${agent.name}".`,
				{ update: updateView(update) }
			);
		})
};
