/**
 * `end_session` (design §5) — say that the run is over.
 *
 * Strictly speaking it is optional: the sweeper closes an idle session after ten
 * minutes either way. It exists because "finished" and "crashed" look identical
 * from the outside for those ten minutes, and an agent that says which one it
 * was takes itself off the rail immediately.
 */
import { endSession } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	session_id: z
		.string()
		.describe('The session_id register_session gave you. Must be one of your own sessions.')
};

export const endSessionTool: McpTool<typeof inputSchema> = {
	name: 'end_session',
	config: {
		title: 'Finish a work session',
		description: [
			'Close the session you opened with register_session, taking yourself off the dashboard’s',
			'live-agents list straight away. Call it when your run is finishing. It is optional — an',
			'idle session is closed automatically after ten minutes — but calling it is the',
			'difference between "finished" and "went quiet" on the owner’s screen.',
			'',
			'Arguments:',
			'- session_id (required): the id register_session returned. It must be one of your own',
			'  sessions; another agent’s session is refused.',
			'',
			'Returns { session_id, ended }. `ended` is false if the session was already closed, which',
			'is not an error: calling this twice is safe.',
			'',
			'On failure: error "not_found" means no such session, so there is nothing to close.',
			'After this, heartbeat on the same session_id is refused with "conflict": register a new',
			'session if you carry on working.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const { session, ended } = endSession(ctx, {
				sessionId: args.session_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id
			});

			return ok(
				ended
					? `Ended session ${session.id}. Agent "${agent.name}" is no longer shown as working.`
					: `Session ${session.id} was already ended; nothing to do.`,
				{ session_id: session.id, ended }
			);
		})
};
