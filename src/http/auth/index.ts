/**
 * Public entry point for owner auth (design §8).
 *
 * One owner, one password, one signed cookie, and one list of the paths that
 * cookie protects. Routes import from here; nothing outside `src/http/` should
 * import this at all.
 */
export {
	attemptLogin,
	createLoginHandler,
	createPasswordCheck,
	LOGIN_MAX_ATTEMPTS,
	LOGIN_WINDOW_MS,
	ownerPasswordCheck
} from './login';
export type { LoginAttempt, LoginOutcome, PasswordCheck, PasswordVerdict } from './login';
export { logout } from './logout';
export { authHandle, createAuthHandle } from './handle';
export { bearerToken } from './bearer';
export type { DeviceTokenCheck } from './bearer';
export { authConfig } from './env';
export type { AuthConfig } from './env';
export {
	isBrowserApi,
	LOGIN_PATH,
	loginRedirect,
	LOGOUT_PATH,
	PUBLIC_PREFIXES,
	requiresSession,
	safeRedirectTarget,
	TOKEN_AUTHED_PREFIXES
} from './guard';
export { hashPassword, verifyPassword } from './password';
export { createRateLimiter } from './rate-limit';
export type { RateLimiter, RateLimitVerdict } from './rate-limit';
export {
	clearSessionCookieOptions,
	readSession,
	SESSION_COOKIE,
	SESSION_TTL_S,
	sessionCookieOptions,
	sessionFromCookies,
	signSession
} from './session';
export type {
	Session,
	SessionCookieOptions,
	SessionCookieReader,
	SessionCookieWriter
} from './session';
