/**
 * `get_messages` (design §5) — read what the owner said.
 *
 * The only tool whose default has a side effect: `mark_read` defaults to true,
 * so the ordinary call is "give me what is new and remember that I have it". An
 * agent that wants to look without committing passes `mark_read: false`, and the
 * same messages come back next time.
 *
 * There is no agent argument, here least of all: the cursor being advanced is
 * the caller's own, resolved from the bearer token, so no agent can mark another
 * agent's messages read (design §5).
 */
import { mediaSettings, readMessages, type MediaSettings } from '$domain';
import { z } from 'zod';
import { attachmentsFor } from '../attachments';
import { guarded, messageView, ok } from '../results';
import type { McpTool } from './types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const inputSchema = {
	since: z
		.string()
		.optional()
		.describe(
			'A cursor from a previous get_messages call. Omit to read from wherever you got to last time.'
		),
	project: z
		.string()
		.optional()
		.describe('Only messages in this project: a slug or an id. Omit for every project.'),
	mark_read: z
		.boolean()
		.optional()
		.describe(
			'Whether this read moves your cursor forward. Defaults to true; pass false to look without committing.'
		)
};

export const getMessagesTool: McpTool<typeof inputSchema, Promise<CallToolResult>> = {
	name: 'get_messages',
	config: {
		title: 'Read messages from your owner',
		description: [
			'Read the messages waiting for you — replies your owner left on your updates, notes on',
			'your tasks, and anything sent to a project you work in. Oldest first, so you can read',
			'them as a conversation. Call this when a heartbeat reports unread_messages above zero.',
			'',
			'Arguments:',
			'- since (optional): a cursor from a previous call. Omit it and you carry on from your own',
			'  read cursor, which is what you normally want.',
			'- project (optional): a project slug or id, to read one project at a time.',
			'- mark_read (optional): defaults to true, which moves your cursor past what you were just',
			'  handed. Pass false to peek — the same messages will come back next time.',
			'',
			'**Images your owner attached come back with the message**, as pictures you can actually',
			"look at rather than ids you cannot fetch — the media routes want your owner's session,",
			'so this tool is the only way you will ever see them. A few per call, thumbnails rather',
			'than originals, and the summary says plainly when something could not be included so you',
			'can ask rather than assume you have seen everything.',
			'',
			'Returns { messages: [{ id, project_id, update_id, task_id, author, body, created_at }],',
			'count, cursor, unread, marked_read }. `author` is the literal "human" for your owner or',
			'"agent:<agent_id>" for another agent; your own messages are never returned to you.',
			'`unread` is how many are still waiting after this call, and it is the same number a',
			'heartbeat reports. `cursor` is what to pass back as `since`.',
			'',
			'A narrowed read (one project, or an explicit since) will not move your cursor past a',
			'message it did not hand you, so nothing is ever lost — but you may be given the same',
			'message twice. Act on it once.',
			'',
			'On failure: "invalid_argument" means a `since` that is not a cursor this server issued,',
			'so omit it and read from your own cursor instead. "not_found" means no such project;',
			'call list_projects to see the slugs.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent, media }, args) =>
		guarded(async () => {
			const page = readMessages(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				since: args.since,
				project: args.project,
				markRead: args.mark_read
			});

			// After the read, never instead of it: an image that cannot be opened
			// must not cost the agent the words it came with — and neither must a
			// deployment with no media configured at all, which is why the settings
			// are resolved defensively rather than at import time.
			const attachments = await attachmentsFor(ctx, settingsFor(media), page.messages);

			return ok(
				summary(page.messages.length, page.unread, attachments.notes),
				{
					messages: page.messages.map(messageView),
					count: page.messages.length,
					cursor: page.cursor,
					unread: page.unread,
					marked_read: page.markedRead
				},
				attachments.images
			);
		})
};

/**
 * Where the media lives, or nowhere.
 *
 * A deployment with no `DATA_DIR` or `TOKEN_SECRET` cannot serve media at all,
 * and `mediaSettings` says so by throwing. That must not cost an agent its
 * messages: the words are the point, and the pictures are what this tool adds
 * to them.
 */
function settingsFor(media: MediaSettings | undefined): MediaSettings | null {
	if (media) return media;
	try {
		return mediaSettings();
	} catch {
		return null;
	}
}

/**
 * The sentence the model actually reads.
 *
 * "No new messages" is worth saying in words for the same reason the heartbeat's
 * "nothing is waiting" is: it is the common answer, and an agent that reads it
 * carries on working instead of going looking through JSON for permission to.
 */
function summary(count: number, unread: number, attachments: string[] = []): string {
	if (count === 0) return 'No new messages. Carry on.';

	const read = `${count} new message${count === 1 ? '' : 's'}, oldest first.`;
	const rest = unread === 0 ? read : `${read} ${unread} still unread; call again for the rest.`;
	// Named rather than left to be noticed: an agent that cannot tell an image
	// was attached will answer the words and ignore the picture, which is the
	// complaint this exists to answer.
	return attachments.length === 0 ? rest : `${rest}\n${attachments.join('\n')}`;
}
