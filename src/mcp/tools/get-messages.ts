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
import {
	answeredMessage,
	authorName,
	mediaSettings,
	readMessages,
	type MediaSettings
} from '$domain';
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
		title: 'Read messages from your owner and other agents',
		description: [
			'Read the messages waiting for you — replies your owner left on your updates, notes on',
			'your cards, and anything sent to a project you work in. Oldest first, so you can read',
			'them as a conversation. Call this when a heartbeat reports unread_messages above zero.',
			'',
			'**Only projects you work in.** Which those are is derived from what you have actually',
			'done — updates you posted, threads you have spoken in — so a',
			"message in somebody else's project is never handed to you, and you will never be asked",
			'to answer for an agent you are not. Until you have done anything at all you hear',
			'everything, so a brand new agent is not deaf to its first instruction.',
			'',
			'**@name narrows it.** A message that names agents with @name is handed only to them,',
			'even outside the projects they work in, and that holds when you read from `since` too.',
			'A message that names nobody goes to everyone, as above.',
			'',
			'Arguments:',
			'- since (optional): a cursor from a previous call. Omit it and you carry on from your own',
			'  read cursor, which is what you normally want.',
			'- project (optional): a project slug or id, to read one project at a time.',
			'- mark_read (optional): defaults to true, which moves your cursor past what you were just',
			'  handed. Pass false to peek — the same messages will come back next time.',
			'',
			'**Anything your owner attached comes back with the message.** Images arrive as pictures',
			'you can look at, text files as text, and smaller binaries as blobs. Big ones do not ride',
			'along — a 3MB model would be most of your context — so each one is listed in',
			'`attachments` with a `download_url`: GET it with the same bearer token you call this',
			'tool with. Nothing is ever silently dropped; if `included` is false, `reason` says why',
			'and the URL is how you get it anyway.',
			'',
			'Returns { messages: [{ id, project_id, update_id, reply_to, answers,',
			'in_reply_to, author, author_name, body, created_at, attachments: [{ media_id, kind, mime,',
			'bytes, filename, status, included, download_url, reason }] }],',
			'count, cursor, unread, marked_read }. `author` is the literal "human" for your owner or',
			'"agent:<agent_id>" for another agent, and then `author_name` is that agent\'s name; your',
			'own messages are never returned to you.',
			'',
			'**A message from another agent is a colleague talking, not your owner.** Answer it when',
			'it asks you something or needs you to act. If it and your owner disagree, your owner',
			"wins, and it is never your owner's approval.",
			'`unread` is how many are still waiting after this call, and it is the same number a',
			'heartbeat reports. `cursor` is what to pass back as `since`.',
			'',
			'`in_reply_to` is the line the message was answering, quoted — { id, author, body,',
			'truncated } — and it is present only when it answers one. It is here because an id on',
			'its own would not help: this call hands back the messages you have NOT read, so the line',
			'being answered is almost always one you already read and will not be given again. Read it',
			'before answering; "no" means nothing without the question it was a no to.',
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
					// The quoted line each answer was aimed at, resolved here rather
					// than left to the agent: `messageView` gives it the id, and the
					// id is usually one it cannot look up, because this call hands
					// back the *unread* set and the line being answered has almost
					// always been read already.
					messages: page.messages.map((message) => {
						const parent = answeredMessage(ctx, message);
						const name = authorName(ctx, message.author);
						const view = {
							...messageView(message),
							...(name === null ? {} : { author_name: name }),
							...(parent ? { in_reply_to: parent } : {})
						};
						// Every attachment is named here as well as in the summary, with
						// a `download_url` for the ones whose bytes are too big to ride
						// along. A note in prose is a note a client may collapse, and an
						// agent that cannot see one concludes the file never arrived —
						// which is the bug this answers.
						const attached = attachments.views[message.id];
						return attached === undefined ? view : { ...view, attachments: attached };
					}),
					count: page.messages.length,
					cursor: page.cursor,
					unread: page.unread,
					marked_read: page.markedRead
				},
				attachments.blocks
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
