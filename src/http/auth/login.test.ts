import { beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, createLoginHandler } from './login';
import { hashPassword } from './password';
import { SESSION_COOKIE, readSession, signSession } from './session';
import { logout } from './logout';

const PASSWORD = 'the owner password';
const SESSION_SECRET = 's'.repeat(32);
const adminPasswordHash = await hashPassword(PASSWORD);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash });

type SetCookie = { name: string; value: string; options: Record<string, unknown> };

/** Captures what the route hands SvelteKit's cookie jar. */
function jar() {
	const wrote: SetCookie[] = [];
	const cleared: SetCookie[] = [];
	return {
		wrote,
		cleared,
		cookies: {
			get: () => undefined,
			set: (name: string, value: string, options: Record<string, unknown>) =>
				void wrote.push({ name, value, options }),
			delete: (name: string, options: Record<string, unknown>) =>
				void cleared.push({ name, value: '', options })
		}
	};
}

let attempt: ReturnType<typeof createLoginHandler>;

beforeEach(() => {
	// A fresh handler per test, so one test's failed attempts cannot rate limit
	// the next one.
	attempt = createLoginHandler({ config });
});

describe('a correct password', () => {
	it('issues a session cookie with all three security attributes (design §8)', async () => {
		const { cookies, wrote } = jar();

		const outcome = await attempt({ password: PASSWORD, clientAddress: '1.2.3.4', cookies });

		expect(outcome).toEqual({ ok: true, redirectTo: '/' });
		expect(wrote).toHaveLength(1);
		expect(wrote[0].name).toBe(SESSION_COOKIE);
		expect(wrote[0].options).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
	});

	it('issues a cookie the guard will accept', async () => {
		const { cookies, wrote } = jar();

		await attempt({ password: PASSWORD, clientAddress: '1.2.3.4', cookies });

		expect(readSession(wrote[0].value, SESSION_SECRET)).not.toBeNull();
	});

	it('returns the owner to where they were headed, but never off-site', async () => {
		const { cookies } = jar();

		await expect(
			attempt({
				password: PASSWORD,
				redirectTo: '/projects/acme?tab=tasks',
				clientAddress: '1.2.3.4',
				cookies
			})
		).resolves.toEqual({ ok: true, redirectTo: '/projects/acme?tab=tasks' });

		await expect(
			attempt({
				password: PASSWORD,
				redirectTo: 'https://evil.example.com',
				clientAddress: '1.2.3.4',
				cookies
			})
		).resolves.toEqual({ ok: true, redirectTo: '/' });
	});
});

describe('a wrong password', () => {
	it('fails and issues nothing', async () => {
		const { cookies, wrote } = jar();

		const outcome = await attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });

		expect(outcome).toMatchObject({ ok: false, status: 400 });
		expect(wrote).toEqual([]);
	});

	it('says the same thing whatever went wrong, so it leaks nothing', async () => {
		const { cookies } = jar();

		const wrongPassword = await attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });
		const notAString = await attempt({ password: 17, clientAddress: '5.6.7.8', cookies });

		expect(wrongPassword).toEqual(notAString);
	});

	it('is rate limited after repeated attempts (design §8)', async () => {
		const { cookies } = jar();
		const guess = () => attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });

		for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
			expect((await guess()).ok, `attempt ${i + 1}`).toBe(false);
		}

		const limited = await guess();

		expect(limited).toMatchObject({ ok: false, status: 429 });
		expect(limited).toHaveProperty('retryAfterS');
	});

	it('locks out the right password too, so the limit cannot be walked around', async () => {
		const { cookies, wrote } = jar();
		for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
			await attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });
		}

		const outcome = await attempt({ password: PASSWORD, clientAddress: '1.2.3.4', cookies });

		expect(outcome).toMatchObject({ ok: false, status: 429 });
		expect(wrote).toEqual([]);
	});

	it('limits the guessing client only, not the owner elsewhere', async () => {
		const { cookies } = jar();
		for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
			await attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });
		}

		const elsewhere = await attempt({ password: PASSWORD, clientAddress: '5.6.7.8', cookies });

		expect(elsewhere).toMatchObject({ ok: true });
	});

	it('forgives the typos once the owner gets in', async () => {
		const { cookies } = jar();
		const guess = () => attempt({ password: 'guess', clientAddress: '1.2.3.4', cookies });
		for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) await guess();

		await attempt({ password: PASSWORD, clientAddress: '1.2.3.4', cookies });

		// The allowance is whole again: a full run of wrong guesses fits before
		// the limiter bites.
		for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
			expect((await guess()).ok, `attempt ${i + 1}`).toBe(false);
		}
		expect(await guess()).toMatchObject({ status: 429 });
	});

	it('has a window measured in minutes, not seconds', () => {
		expect(LOGIN_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
	});
});

describe('an empty submission', () => {
	it('is a prompt, not a guess: it does not eat the owner’s allowance', async () => {
		const { cookies } = jar();

		for (let i = 0; i < LOGIN_MAX_ATTEMPTS * 2; i++) {
			expect(await attempt({ password: '', clientAddress: '1.2.3.4', cookies })).toMatchObject({
				ok: false,
				status: 400
			});
		}

		expect(await attempt({ password: PASSWORD, clientAddress: '1.2.3.4', cookies })).toMatchObject({
			ok: true
		});
	});
});

describe('a deployment with no ADMIN_PASSWORD_HASH', () => {
	it('cannot be logged into, and says so', async () => {
		const { cookies, wrote } = jar();
		const unconfigured = createLoginHandler({ config: () => null });

		const outcome = await unconfigured({ password: PASSWORD, clientAddress: '1.2.3.4', cookies });

		expect(outcome).toMatchObject({ ok: false, status: 503 });
		expect(wrote).toEqual([]);
	});
});

describe('logout', () => {
	it('clears the session cookie with the attributes it was set with', () => {
		const { cookies, cleared } = jar();

		logout(cookies);

		expect(cleared).toHaveLength(1);
		expect(cleared[0].name).toBe(SESSION_COOKIE);
		expect(cleared[0].options).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
	});

	it('leaves a cookie the browser kept unusable, because it is only ever verified', () => {
		// Belt and braces: even a client that ignores the clear cannot reuse the
		// value past its expiry, and the server holds no session state to leak.
		const value = signSession(SESSION_SECRET, { ttlS: 1 });

		expect(readSession(value, SESSION_SECRET, Date.now() + 2000)).toBeNull();
	});
});
