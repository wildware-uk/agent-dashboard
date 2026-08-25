/**
 * The single owner password (design §8).
 *
 * argon2id, because unlike an agent token this is a human-chosen secret and has
 * to survive an offline attack on the hash. Agent tokens are 256-bit random and
 * only ever HMAC'd — see `src/media/` and the token slice — so the expensive
 * KDF lives here and nowhere else.
 *
 * The hash comes from `ADMIN_PASSWORD_HASH` and is never written by the app:
 * there is no user table and no password-change endpoint. `hashPassword` exists
 * for the `.env.example` one-liner, the packaging CLI, and these tests.
 */
import argon2 from 'argon2';

/**
 * Hash a password the way `ADMIN_PASSWORD_HASH` expects.
 *
 * Defaults from the argon2 library are already the OWASP-recommended
 * parameters; only the variant needs stating, since `config.ts` insists on
 * argon2id and the library's default is argon2i.
 */
export function hashPassword(password: string): Promise<string> {
	return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Check a submitted password against the configured hash.
 *
 * @returns `false` rather than throwing when the hash is missing or malformed.
 *   A misconfigured `ADMIN_PASSWORD_HASH` must lock the owner out, not 500 on
 *   every login attempt — and it must not tell the client which of the two
 *   happened.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	if (!password || !hash) return false;
	try {
		return await argon2.verify(hash, password);
	} catch {
		return false;
	}
}
