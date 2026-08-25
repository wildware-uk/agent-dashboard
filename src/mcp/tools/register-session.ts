/**
 * `register_session` (design §5) — how an agent announces that it is alive.
 *
 * The agent is `deps.agent`, resolved from the bearer token by `../auth.ts`, so
 * there is no argument for identity and no way to register a session for anybody
 * else (§5).
 *
 * `meta` is the only argument, and it is optional: an agent that knows nothing
 * about its own host can still register, because being on the rail matters more
 * than being described on it.
 */
import { CWD_MAX_LENGTH, HOST_MAX_LENGTH, MODEL_MAX_LENGTH, registerSession } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	meta: z
		.object({
			host: z
				.string()
				.max(HOST_MAX_LENGTH)
				.optional()
				.describe('The machine you are running on, e.g. "wildware" or a container name.'),
			cwd: z
				.string()
				.max(CWD_MAX_LENGTH)
				.optional()
				.describe('The absolute working directory you were started in, e.g. "/srv/app".'),
			model: z
				.string()
				.max(MODEL_MAX_LENGTH)
				.optional()
				.describe('The model you are, e.g. "claude-opus-5". Shown next to your name.')
		})
		.optional()
		.describe(
			'Optional description of this run — { host, cwd, model } — shown in the dashboard so ' +
				'the owner can tell two runs of the same agent apart. Any other field is ignored.'
		)
};

export const registerSessionTool: McpTool<typeof inputSchema> = {
	name: 'register_session',
	config: {
		title: 'Register a work session',
		description: [
			'Announce that you have started work. Call this once when your run begins, then call',
			'heartbeat on the interval it returns; the dashboard shows you as online for as long as',
			'your heartbeats keep arriving, and the owner can see at a glance which agents are alive.',
			'',
			'Arguments:',
			'- meta (optional): { host, cwd, model } describing where you are running. Every field is',
			'  optional text and any other field is ignored. Register without it rather than not at',
			'  all.',
			'',
			'Returns { session_id, heartbeat_interval_s }. Keep the session_id: heartbeat and',
			'end_session both take it, and it is the only handle on this run. Beat at least as often',
			'as heartbeat_interval_s says, because presence is derived purely from how recently your',
			'last heartbeat arrived.',
			'',
			'The session belongs to the agent your bearer token identifies, so there is deliberately',
			'no argument for who you are, and no other agent can beat for you or end your session.',
			'',
			'Calling this twice opens two sessions, which is correct if you really are two runs; if',
			'you have merely lost your session_id, register again and let the old session be swept.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const { session, heartbeatIntervalS } = registerSession(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				meta: args.meta
			});

			return ok(
				`Registered session ${session.id} for agent "${agent.name}". ` +
					`Call heartbeat({session_id}) at least every ${heartbeatIntervalS} seconds, ` +
					`and end_session({session_id}) when you finish.`,
				{ session_id: session.id, heartbeat_interval_s: heartbeatIntervalS }
			);
		})
};
