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
import { CRITICAL_PRIORITY } from './priority';
import {
	BODY_MAX_LENGTH,
	APPS_PER_POST_MAX,
	appsOn,
	EMBEDS_PER_POST_MAX,
	MEDIA_PER_UPDATE_MAX,
	TITLE_MAX_LENGTH,
	postUpdate
} from '$domain';
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
	priority: z
		.enum(['low', 'medium', 'high', 'critical'])
		.optional()
		.describe(
			'How much this needs your owner NOW: "low", "medium" (the default) or "high". A ' +
				'different question from level — level is what happened, priority is whether it can ' +
				'wait. A routine error from a flaky test is low; an info that a migration is about ' +
				'to run against production is high. Your owner filters notifications on this, per ' +
				'device, so "high" is what reaches a phone at 2am. Use it sparingly or it stops ' +
				'meaning anything. ' +
				CRITICAL_PRIORITY
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
			`Files to put on the card: ids from create_upload whose bytes you have ` +
				`already PUT, at most ${MEDIA_PER_UPDATE_MAX}. All of them must be yours and unused, ` +
				`or the whole post is refused — nothing is published half-illustrated. If an upload ` +
				`finishes after you post, use attach_media instead.`
		),
	embeds: z
		.array(
			z.object({
				type: z.string().describe("The look's slug, from list_embed_types."),
				data: z
					.record(z.string(), z.unknown())
					.describe('The values it shows, e.g. { "username": "sam", "text": "it is green" }.'),
				source_url: z
					.string()
					.optional()
					.describe('Where you copied it from, if anywhere. http or https.')
			})
		)
		.max(EMBEDS_PER_POST_MAX)
		.optional()
		.describe(
			`Things to show in a registered look — a Slack message, a GitHub comment, a Jira ` +
				`ticket — instead of pasting them as flat text. At most ${EMBEDS_PER_POST_MAX}. Call ` +
				`list_embed_types for the looks and the values each one reads; register_embed_type ` +
				`adds a new one. An unknown look fails the whole post rather than dropping the embed.`
		),
	apps: z
		.array(
			z.object({
				app: z.string().describe("The app's ui:// URI, from list_apps or register_app."),
				data: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('What to hand it, e.g. { "open": 3, "files": ["fees.ts"] }.'),
				title: z.string().optional().describe('A line above the frame.')
			})
		)
		.max(APPS_PER_POST_MAX)
		.optional()
		.describe(
			`Interactive UI to put on the card — a board your owner can tick through, a chart ` +
				`of the run you are in the middle of. At most ${APPS_PER_POST_MAX}. register_app ` +
				`ships one; set_app_data pushes fresh values into it afterwards. An unknown app fails ` +
				`the whole card rather than dropping the frame.`
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
			'- priority (optional): "low", "medium" (default), "high" or "critical" — whether it can',
			'  wait. Your owner filters notifications on it per device, so "high" is what reaches a',
			`  phone. ${CRITICAL_PRIORITY}`,
			`- media_ids (optional): up to ${MEDIA_PER_UPDATE_MAX} ids from create_upload whose bytes`,
			'  you have already uploaded. Images and video render on the card; anything else is',
			'  listed as a download.',
			'- embeds (optional): things to show in a registered look — a Slack message, a GitHub',
			'  comment, a Jira ticket — rather than pasted as flat text. Each is { type, data,',
			'  source_url? }; list_embed_types says which looks exist and which values each reads.',
			'- apps (optional): interactive UI, rendered in a sandboxed frame on the card. Each is',
			'  { app: "ui://…", data?, title? }; register_app ships one and list_apps says what',
			'  exists. set_app_data pushes fresh values into one already posted.',
			'',
			'If the card is a piece of work, mark it with set_status — "in_progress" while you are',
			'on it, "done" when it is finished. That is what the task board used to be.',
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
				priority: args.priority,
				sessionId: args.session_id,
				mediaIds: args.media_ids,
				apps: args.apps?.map((app) => ({
					app: app.app,
					data: app.data,
					title: app.title
				})),
				embeds: args.embeds?.map((embed) => ({
					type: embed.type,
					data: embed.data,
					sourceUrl: embed.source_url
				}))
			});

			// The showings' ids, so an agent can push fresh values into one with
			// set_app_data without having to go looking for what it just posted.
			const apps = args.apps?.length ? appsOn(ctx, { kind: 'update', id: update.id }) : [];

			return ok(
				`Posted a ${update.level} update to project ${args.project} as agent "${agent.name}".`,
				{
					update: updateView(update),
					...(apps.length > 0
						? { apps: apps.map((app) => ({ view_id: app.id, uri: app.uri, title: app.title })) }
						: {})
				}
			);
		})
};
