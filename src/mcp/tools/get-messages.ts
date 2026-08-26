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
import { readMessages } from '$domain';
import { z } from 'zod';
import { guard, messageView, ok } from '../results';
import type { McpTool } from './types';

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

export const getMessagesTool: McpTool<typeof inputSchema> = {
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

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const page = readMessages(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				since: args.since,
				project: args.project,
				markRead: args.mark_read
			});

			return ok(summary(page.messages.length, page.unread), {
				messages: page.messages.map(messageView),
				count: page.messages.length,
				cursor: page.cursor,
				unread: page.unread,
				marked_read: page.markedRead
			});
		})
};

/**
 * The sentence the model actually reads.
 *
 * "No new messages" is worth saying in words for the same reason the heartbeat's
 * "nothing is waiting" is: it is the common answer, and an agent that reads it
 * carries on working instead of going looking through JSON for permission to.
 */
function summary(count: number, unread: number): string {
	if (count === 0) return 'No new messages. Carry on.';

	const read = `${count} new message${count === 1 ? '' : 's'}, oldest first.`;
	return unread === 0 ? read : `${read} ${unread} still unread; call again for the rest.`;
}
