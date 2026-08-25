/**
 * Upload tokens (design §6, §8).
 *
 * A token is `<upload_tokens.id>.<HMAC-SHA256 of that id>`, base64url, signed
 * with `TOKEN_SECRET` — the same key agent tokens are keyed under, and never
 * exposed. Everything else about the grant (which media, which agent, the byte
 * cap, the mime allowlist, the expiry) is a column on the row, so the token is a
 * pointer and not a claim: an attacker who forges a bigger `max_bytes` into a
 * token string has forged nothing, because nothing reads it from there.
 *
 * The signature earns its keep even so. Row ids are ULIDs, which are
 * time-ordered, so without it a caller could walk plausible ids and probe the
 * database for a live grant. With it, an unsigned guess costs one HMAC and never
 * reaches SQLite.
 *
 * **Single use is enforced in the database, not here.** `consumeUploadToken` is
 * one conditional UPDATE, so of two concurrent PUTs presenting the same token
 * exactly one proceeds. A signature cannot express "already spent", and anything
 * this module remembered would be a second, racing copy of that fact.
 */
import { isId } from '$db';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MediaSettings } from './settings';

/** How long a minted token is good for (design §6). */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Path uploads are PUT to. Exempt from the session guard in `src/http/auth/guard.ts`. */
export const UPLOAD_ROUTE = '/api/upload';

/**
 * Domain separation: this key also signs agent tokens, and a signature valid for
 * one purpose must never be valid for another.
 */
const PURPOSE = 'agent-dashboard:upload-token:v1';

function sign(secret: string, id: string): string {
	return createHmac('sha256', secret).update(`${PURPOSE}:${id}`).digest('base64url');
}

/** The token string for an `upload_tokens` row. */
export function signUploadToken(secret: string, id: string): string {
	return `${id}.${sign(secret, id)}`;
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function sameSignature(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * The row id inside a token, if the signature is ours.
 *
 * @returns the id, or `undefined` for anything malformed, forged, or signed with
 *   another key. One answer for every failure: a caller that could tell them
 *   apart would have an oracle for guessing.
 */
export function parseUploadToken(secret: string, raw: string): string | undefined {
	const parts = raw.split('.');
	if (parts.length !== 2) return undefined;

	const [id, signature] = parts;
	// Checked before the HMAC so a flood of nonsense costs a regex, not a hash,
	// and so nothing that is not a ULID can reach a query or a path.
	if (!isId(id) || signature === '') return undefined;

	return sameSignature(signature, sign(secret, id)) ? id : undefined;
}

/** Where a token is spent, as a path. */
export function uploadPath(token: string): string {
	return `${UPLOAD_ROUTE}/${token}`;
}

/**
 * The absolute URL an agent PUTs to.
 *
 * Absolute, and from `PUBLIC_BASE_URL`: an agent runs on another machine, so a
 * relative URL is useless to it and the bind address is worse than useless
 * (design §12).
 */
export function uploadUrl(settings: MediaSettings, token: string): string {
	return `${settings.baseUrl}${uploadPath(token)}`;
}
