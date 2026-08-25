/**
 * The two environment values auth needs, or nothing.
 *
 * Auth reads its secrets through `src/config.ts` so the validation rules live in
 * one place. Failure returns `null` rather than throwing, which is what makes
 * the guard fail *closed*: a deployment whose environment does not validate
 * cannot mint or verify a session at all, so every guarded route bounces to a
 * login page that says the deployment is not configured. Booting loudly on a bad
 * environment is `src/config.ts`'s job, not the request path's.
 */
import { loadConfig, type RawEnv } from '$config';

export type AuthConfig = {
	/** `SESSION_SECRET`: signs the session cookie. */
	sessionSecret: string;
	/** `ADMIN_PASSWORD_HASH`: the argon2id hash of the one owner password. */
	adminPasswordHash: string;
};

export function authConfig(env: RawEnv = process.env): AuthConfig | null {
	try {
		const config = loadConfig(env);
		return {
			sessionSecret: config.SESSION_SECRET,
			adminPasswordHash: config.ADMIN_PASSWORD_HASH
		};
	} catch {
		return null;
	}
}
