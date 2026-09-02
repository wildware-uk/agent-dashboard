/**
 * `heartbeat` (design §5) — stay online, and find out what is waiting.
 *
 * The counts ride along on purpose: an agent that had to call three tools to
 * learn whether there was a message, a task or an approval for it would either
 * spend its context polling or stop asking. One beat answers all three, and the
 * agent only reaches for the specific tool when a count is not zero.
 *
 * `session_id` is an argument because a session is not an identity: the agent is
 * still resolved from the bearer token, and the domain refuses a session that
 * belongs to a different agent, so knowing another agent's session id buys
 * nothing (design §5).
 */
import { heartbeat } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	session_id: z
		.string()
		.describe('The session_id register_session gave you. Must be one of your own sessions.')
};

export const heartbeatTool: McpTool<typeof inputSchema> = {
	name: 'heartbeat',
	config: {
		title: 'Report that you are still working',
		description: [
			'Tell the dashboard you are still alive, and find out whether anything is waiting for',
			'you. Call this on the interval register_session returned. Presence is derived from your',
			'last heartbeat alone, so an agent that stops beating is shown as offline shortly',
			'afterwards, and a session left idle for ten minutes is closed.',
			'',
			'Arguments:',
			'- session_id (required): the id register_session returned. It must be one of your own',
			'  sessions; another agent’s session is refused.',
			'',
			'Returns { ok, unread_messages, open_tasks, pending_approvals }. The three counts are',
			'piggybacked so you never have to poll for work: while they are zero there is nothing',
			'for you, and when one is not, call the tool for that kind of work.',
			'',
			'open_tasks is your own todo and claimed tasks, plus any work the owner has broadcast to',
			"a project you work in — offered to the project's agents rather than assigned to one of",
			'them. So a rise you were not expecting may be a task nobody holds: list_tasks marks',
			'those `broadcast: true`, and whoever claims first gets it.',
			'',
			'On failure there are three codes, and each has a different answer. "not_found" means no',
			'such session: call register_session and use the id it returns. "invalid_argument" means',
			'that session belongs to another agent, so you sent an id that is not yours — beat on your',
			'own. "conflict" means your session has ended (you ended it, or it was idle too long), so',
			'register a new one and use its id from then on. Any other failure is a bug in the',
			'dashboard rather than in your call.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const counts = heartbeat(ctx, {
				sessionId: args.session_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id
			});

			return ok(summary(counts), {
				ok: counts.ok,
				unread_messages: counts.unreadMessages,
				open_tasks: counts.openTasks,
				pending_approvals: counts.pendingApprovals
			});
		})
};

/**
 * The sentence the model actually reads.
 *
 * "Nothing waiting" is worth saying in words: it is the answer in the
 * overwhelming majority of beats, and an agent that reads it does not go looking
 * through the JSON for permission to carry on working.
 */
function summary(counts: {
	unreadMessages: number;
	openTasks: number;
	pendingApprovals: number;
}): string {
	const waiting = [
		[counts.unreadMessages, 'unread message'],
		[counts.openTasks, 'open task'],
		[counts.pendingApprovals, 'pending approval']
	] as const;

	const parts = waiting
		.filter(([count]) => count > 0)
		.map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`);

	return parts.length === 0
		? 'Heartbeat recorded. Nothing is waiting for you; carry on.'
		: `Heartbeat recorded. Waiting for you: ${parts.join(', ')}.`;
}
