/**
 * Checking the one owner password and issuing the session (design §8).
 *
 * The route in `src/http/routes/login/` is a five-line adapter over this: form
 * data in, `LoginOutcome` out. Keeping the decision here means the interesting
 * parts — what counts against the rate limit, what the failure message gives
 * away, what the cookie carries — are unit tested without a running server.
 */
import { authConfig, type AuthConfig } from './env';
import { safeRedirectTarget } from './guard';
import { verifyPassword } from './password';
import { createRateLimiter, type RateLimiter } from './rate-limit';
import {
	SESSION_COOKIE,
	sessionCookieOptions,
	signSession,
	type SessionCookieWriter
} from './session';

/**
 * Five guesses per quarter hour per client.
 *
 * argon2id already makes each attempt expensive; this stops a patient script from
 * ever getting through the door.
 *
 * It is only per-client if `clientAddress` is really the client. Behind a reverse
 * proxy, adapter-node reports the socket peer — `127.0.0.1` for every request on
 * the internet — which collapses this into one shared bucket and lets any stranger
 * lock the owner out for the window with five wrong guesses. The deployment must
 * set `ADDRESS_HEADER` and `XFF_DEPTH` (see `.env.example`); `assertClientAddressTrustworthy`
 * in `$config` fails startup if it looks like they were forgotten.
 */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * One message for every wrong-password shape. "No such user" does not exist
 * here — there is one owner — and "malformed hash" is the deployment's problem,
 * not something to hand a guesser.
 */
const WRONG = 'That password is not right.';
const BLANK = 'Enter your password.';
const UNCONFIGURED =
	'This deployment has no valid ADMIN_PASSWORD_HASH and SESSION_SECRET, so nobody can log in. ' +
	'See .env.example.';
const LIMITED = 'Too many attempts. Try again later.';

export type LoginAttempt = {
	/** Straight off the form, so `unknown`: `FormData` yields files too. */
	password: unknown;
	/** Where the owner was headed before the guard intercepted them. */
	redirectTo?: string | null;
	/** `event.getClientAddress()`. The rate-limit key. */
	clientAddress: string;
	cookies: SessionCookieWriter;
};

export type LoginOutcome =
	| { ok: true; redirectTo: string }
	| { ok: false; status: 400; error: string }
	| { ok: false; status: 429; error: string; retryAfterS: number }
	| { ok: false; status: 503; error: string };

export type LoginHandlerOptions = {
	config?: () => AuthConfig | null;
	limiter?: RateLimiter;
	now?: () => number;
};

/**
 * Build a login handler.
 *
 * The limiter is created per handler and held in its closure, so the process-wide
 * singleton below is the only shared state and tests get a clean one each time.
 */
export function createLoginHandler({
	config = authConfig,
	now = Date.now,
	limiter = createRateLimiter({
		limit: LOGIN_MAX_ATTEMPTS,
		windowMs: LOGIN_WINDOW_MS,
		now
	})
}: LoginHandlerOptions = {}) {
	return async function attemptLogin(attempt: LoginAttempt): Promise<LoginOutcome> {
		const secrets = config();
		if (!secrets) return { ok: false, status: 503, error: UNCONFIGURED };

		// An empty form is a mis-click, not a guess. Spending an attempt on it
		// would let the owner lock themselves out by pressing enter.
		if (attempt.password === '') return { ok: false, status: 400, error: BLANK };

		const verdict = limiter.check(attempt.clientAddress);
		if (!verdict.allowed) {
			// The limit applies to the right password too: a limiter that stepped
			// aside for a correct guess is not a limiter.
			return {
				ok: false,
				status: 429,
				error: LIMITED,
				retryAfterS: Math.ceil(verdict.retryAfterMs / 1000)
			};
		}

		const password = typeof attempt.password === 'string' ? attempt.password : '';
		if (!(await verifyPassword(password, secrets.adminPasswordHash))) {
			limiter.record(attempt.clientAddress);
			return { ok: false, status: 400, error: WRONG };
		}

		limiter.reset(attempt.clientAddress);
		attempt.cookies.set(
			SESSION_COOKIE,
			signSession(secrets.sessionSecret, { now: now() }),
			sessionCookieOptions()
		);

		return { ok: true, redirectTo: safeRedirectTarget(attempt.redirectTo) };
	};
}

/**
 * The handler the login route uses. Module scope on purpose: the rate limiter
 * has to outlive a single request to mean anything.
 */
export const attemptLogin = createLoginHandler();
