/**
 * Signing out (design §8).
 *
 * There is no server-side session to destroy — a session is a signed cookie and
 * nothing else — so logging out is exactly "stop sending it". The clearing
 * cookie has to repeat the attributes it was set with, or the browser keeps the
 * one it already has.
 */
import { SESSION_COOKIE, clearSessionCookieOptions, type SessionCookieWriter } from './session';

export function logout(cookies: SessionCookieWriter): void {
	cookies.delete(SESSION_COOKIE, clearSessionCookieOptions());
}
