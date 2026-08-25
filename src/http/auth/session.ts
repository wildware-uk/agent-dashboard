/**
 * The owner's session cookie (design §8).
 *
 * There is one owner and no user table, so a session is not a database row: it
 * is a signed statement that whoever holds this cookie proved they knew the
 * password. The cookie is therefore self-contained — an HMAC over its own
 * issue and expiry times — and the only server-side state is `SESSION_SECRET`.
 * Rotating that secret invalidates every cookie, which is exactly the "log me
 * out everywhere" lever a single-owner deployment needs.
 *
 * This module is pure: the secret arrives as an argument. Nothing here reads
 * the environment, so tests exercise it without one.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Deliberately not `session` or `token`: it must never be mistaken for an agent token. */
export const SESSION_COOKIE = 'ad_session';

/** Thirty days. A self-hosted dashboard the owner glances at from a phone. */
export const SESSION_TTL_S = 60 * 60 * 24 * 30;

/** Refuse to sign or verify with a secret too short to be one. Mirrors `src/config.ts`. */
const MIN_SECRET_LENGTH = 32;

/** What a valid cookie asserts. Epoch milliseconds, to match `Date.now()`. */
export type Session = { issuedAt: number; expiresAt: number };

/**
 * The cookie attributes the design names, as a value so that the login route and
 * its tests cannot drift apart.
 *
 * `secure` is unconditional: browsers make an exception for `http://localhost`,
 * so dev still works, and every other deployment is behind TLS or is broken.
 * `SameSite=Lax` keeps the cookie off cross-site POSTs while still arriving when
 * the owner follows a link to the dashboard.
 */
export type SessionCookieOptions = {
	path: '/';
	httpOnly: true;
	secure: true;
	sameSite: 'lax';
	maxAge: number;
};

export function sessionCookieOptions(maxAgeS: number = SESSION_TTL_S): SessionCookieOptions {
	return { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: maxAgeS };
}

/**
 * The attributes used to clear it. A browser only drops a cookie when the
 * clearing `Set-Cookie` matches the one it stored, so these have to agree with
 * `sessionCookieOptions` on everything but the lifetime.
 */
export function clearSessionCookieOptions(): Omit<SessionCookieOptions, 'maxAge'> {
	return { path: '/', httpOnly: true, secure: true, sameSite: 'lax' };
}

/** The slice of SvelteKit's `Cookies` this module needs. Keeps tests trivial. */
export type SessionCookieReader = { get(name: string): string | undefined };

export type SessionCookieWriter = SessionCookieReader & {
	set(name: string, value: string, options: SessionCookieOptions): void;
	delete(name: string, options: Omit<SessionCookieOptions, 'maxAge'>): void;
};

function sign(payload: string, secret: string): string {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Mint a cookie value. `now` and `ttlS` exist so tests need no fake timers. */
export function signSession(
	secret: string,
	{ now = Date.now(), ttlS = SESSION_TTL_S }: { now?: number; ttlS?: number } = {}
): string {
	const session: Session = { issuedAt: now, expiresAt: now + ttlS * 1000 };
	const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
	return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a cookie value.
 *
 * @returns the session it asserts, or `null` for anything unsigned, tampered,
 *   expired, malformed, or verified against an unusable secret. Every failure is
 *   the same `null`: callers must not be able to tell a forgery from an expiry.
 */
export function readSession(
	value: string | undefined | null,
	secret: string,
	now: number = Date.now()
): Session | null {
	if (!value || !secret || secret.length < MIN_SECRET_LENGTH) return null;

	const dot = value.indexOf('.');
	if (dot < 1 || dot === value.length - 1) return null;
	const payload = value.slice(0, dot);
	const signature = value.slice(dot + 1);

	const expected = Buffer.from(sign(payload, secret));
	const actual = Buffer.from(signature);
	// timingSafeEqual throws on a length mismatch, so that has to be checked
	// first; the length of an HMAC is not a secret.
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

	let session: unknown;
	try {
		session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof session !== 'object' || session === null) return null;

	const { issuedAt, expiresAt } = session as Partial<Session>;
	if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') return null;
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
	if (expiresAt <= now) return null;

	return { issuedAt, expiresAt };
}

/** Read the session straight off a request's cookies. */
export function sessionFromCookies(
	cookies: SessionCookieReader,
	secret: string,
	now: number = Date.now()
): Session | null {
	return readSession(cookies.get(SESSION_COOKIE), secret, now);
}
