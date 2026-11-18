/**
 * `post_message` (design §5, §7) — answer the owner where they asked.
 *
 * The other half of `get_messages`, and until this existed the conversation was
 * one-way: the owner could reply on a card and the agent could only answer by
 * posting a *new* update, which reads as ignoring them and buries the exchange
 * somewhere other than where it started.
 *
 * **A reply is not an update.** `post_update` announces something that happened
 * and takes a level, a priority and media; this puts a line in a thread that is
 * already on screen. Using an update for a reply is what makes a timeline of
 * "as discussed" cards nobody can follow.
 *
 * The anchor is the argument that matters. `update_id` puts the message in that
 * card's thread, which is where the owner is looking; `project` alone is a note
 * in the project's conversation. A reply that named neither would land in a
 * thread the owner has to go and find.
 *
 * There is no author argument, deliberately and for the same reason no other
 * tool has one: the writer is resolved from the bearer token, so an agent can
 * only ever speak as itself (§5).
 */
import { APPS_PER_POST_MAX, EMBEDS_PER_POST_MAX, appsOn, postMessage } from '$domain';
import { z } from 'zod';
import { guard, messageView, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	body: z
		.string()
		.describe(
			'What to say, as markdown. Raw HTML is shown as text, never executed. This is a line in a conversation, so write it as one.'
		),
	update_id: z
		.string()
		.optional()
		.describe(
			'The update whose thread this belongs in — normally the update_id off the message you are answering, so your reply appears under it on the same card.'
		),
	message_id: z
		.string()
		.optional()
		.describe(
			"The owner's own post to answer, from get_messages or a channel event — a post that " +
				'names no update and no task is one they wrote straight into the feed. Reply to the ' +
				'post itself, never to another reply.'
		),
	answers: z
		.string()
		.optional()
		.describe(
			'A comment in a thread that this message is a direct answer to, from get_messages. ' +
				'Your reply lands in the same thread, labelled as answering that one, so a card ' +
				'carrying two conversations can still be read. It supplies the thread on its own: ' +
				'you need not also pass update_id.'
		),
	request_id: z
		.string()
		.optional()
		.describe(
			'A question of your own your owner has replied to instead of answering, from a ' +
				'message`s request_id. Your reply joins that question`s discussion, where they are ' +
				'looking. The question stays open: keep waiting on it with await_request.'
		),
	project: z
		.string()
		.optional()
		.describe(
			'A project slug or id, for a note that answers no particular card. Derived from the update or task when you name one, so you rarely need it.'
		),
	media_ids: z
		.array(z.string())
		.optional()
		.describe(
			'Files to put on this reply: ids from create_upload whose bytes you have ' +
				'already PUT. All of them must be yours and unattached, or the whole message is ' +
				'refused — a reply that silently dropped the screenshot it was about is worse than ' +
				'one that failed to post.'
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
				`adds a new one. An unknown look fails the whole message rather than dropping the embed.`
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
			`Interactive UI to put on the message — a board your owner can tick through, a chart ` +
				`of the run you are in the middle of. At most ${APPS_PER_POST_MAX}. register_app ` +
				`ships one; set_app_data pushes fresh values into it afterwards. An unknown app fails ` +
				`the whole message rather than dropping the frame.`
		)
};

export const postMessageTool: McpTool<typeof inputSchema> = {
	name: 'post_message',
	config: {
		title: 'Reply to your owner',
		description: [
			'Reply to your owner in a thread — normally the one you were just read a message from.',
			'It appears on their screen live, under the card they were looking at.',
			'',
			'Use this rather than post_update to *answer* something. An update announces what',
			'happened and gets its own card; a message is a line in a conversation already on',
			'screen. Answering a reply with a new update reads as ignoring it.',
			'',
			'Arguments:',
			'- body (required): what to say, as markdown, at most 10000 characters. Write @name (an',
			"  agent's name) to reach only that agent; leave it out and every agent in the project",
			'  hears it.',
			'- update_id (optional): the update to reply under. Pass the `update_id` from the',
			'  message you are answering and your reply lands on the same card.',
			"- message_id (optional): the owner's own feed post to answer. They can write straight",
			'  into the timeline, and such a post hangs off no update and no task — it *is* the thing',
			'  being discussed, so a reply names it. You may also name a reply — including one your',
			'  owner wrote inside a thread — and your answer is filed under the same post, so a thread',
			'  is always one level deep.',
			'- answers (optional): the id of a comment you are answering directly. Your reply stays in',
			'  the same thread and is labelled "answering <them>", which is how a thread with two',
			'  conversations in it stays readable. Naming it is enough — the thread comes with it.',
			'- request_id (optional): a question of yours your owner replied to rather than',
			'  answering — the request_id on their message. Your reply joins that question`s own',
			'  discussion, under the question, which is where they are reading. It is a thread like',
			'  any other, so answers works in it too. The question is still open while you talk:',
			'  keep await_request running, and expect the button to be pressed once you have',
			'  answered what they asked. Do not name a card as well; the question is the anchor.',
			'- project (optional): a slug or id, for a note that answers no card. Taken from the',
			'  update or task when you name one.',
			'- media_ids (optional): files to put on the reply, from create_upload with their bytes',
			'  already uploaded. Answer with the screenshot rather than describing it.',
			'- embeds (optional): things to show in a registered look — a Slack message, a GitHub',
			'  comment, a Jira ticket — rather than pasted as flat text. Each is { type, data,',
			'  source_url? }; list_embed_types says which looks exist and which values each reads.',
			'- apps (optional): interactive UI, rendered in a sandboxed frame on the message. Each is',
			'  { app: "ui://…", data?, title? }; register_app ships one and list_apps says what',
			'  exists. set_app_data pushes fresh values into one already posted.',
			'',
			'Returns { message: { id, project_id, update_id, reply_to, author, body,',
			'created_at } }.',
			'`author` is your own `agent:<agent_id>`: the writer comes from your bearer token, so you',
			'can only ever post as yourself.',
			'',
			'On failure: "not_found" means the update, task, message or project matched nothing — a',
			'deleted update is gone rather than silently re-anchored. "invalid_argument" means an',
			'empty or over-long body, that you named both update_id and message_id, or that you',
			'named a project that disagrees with the one the anchor belongs to.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const message = postMessage(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				author: { kind: 'agent', agentId: agent.id },
				body: args.body,
				updateId: args.update_id,
				replyTo: args.message_id,
				answers: args.answers,
				requestId: args.request_id,
				project: args.project,
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

			// The showings' ids, so set_app_data can push fresh values into one
			// without the agent having to go looking for what it just posted.
			const apps = args.apps?.length ? appsOn(ctx, { kind: 'message', id: message.id }) : [];

			return ok('Replied. It is on your owner’s screen now.', {
				message: messageView(message),
				...(apps.length > 0
					? { apps: apps.map((app) => ({ view_id: app.id, uri: app.uri, title: app.title })) }
					: {})
			});
		})
};
