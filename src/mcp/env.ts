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
};

export function mcpConfig(env: RawEnv = process.env): McpConfig | null {
	try {
		return { tokenSecret: loadConfig(env).TOKEN_SECRET };
	} catch {
		return null;
	}
}
