/**
 * The one environment value the MCP surface needs, or nothing.
 *
 * Same shape as `src/http/auth/env.ts`, for the same reason: validation rules
 * live in `src/config.ts`, and a deployment whose environment does not validate
 * must **fail closed** — with no `TOKEN_SECRET` there is no way to verify a
 * token, so every request is refused rather than served to an unauthenticated
 * caller. Booting loudly on a bad environment is `src/config.ts`'s job, not the
 * request path's.
 */
import { loadConfig, type RawEnv } from '$config';

export type McpConfig = {
	/** `TOKEN_SECRET`: the HMAC key agent tokens are stored under (design §8). */
	tokenSecret: string;
	/**
	 * `HOLD_S` in milliseconds: how long `request_input` parks before handing the
	 * agent a `pending` result to resume on (design §5).
	 *
	 * Read here rather than in the tool so the request path never touches the
	 * environment, and so a deployment that wants a shorter hold — a client with
	 * a 30 second tool timeout — changes one variable.
	 */
	holdMs: number;
};

export function mcpConfig(env: RawEnv = process.env): McpConfig | null {
	try {
		const config = loadConfig(env);
		return { tokenSecret: config.TOKEN_SECRET, holdMs: config.HOLD_S * 1_000 };
	} catch {
		return null;
	}
}
