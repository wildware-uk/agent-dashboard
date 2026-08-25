import { describe, expect, it } from 'vitest';
import {
	SESSION_COOKIE,
	SESSION_TTL_S,
	clearSessionCookieOptions,
	readSession,
	sessionCookieOptions,
	signSession
} from './session';

const SECRET = 'x'.repeat(32);
const OTHER_SECRET = 'y'.repeat(32);

describe('the session cookie', () => {
	it('carries all three security attributes (design §8)', () => {
		const options = sessionCookieOptions();

		expect(options.httpOnly).toBe(true);
		expect(options.secure).toBe(true);
		expect(options.sameSite).toBe('lax');
	});

	it('is scoped to the whole site and expires with the session', () => {
		expect(sessionCookieOptions().path).toBe('/');
		expect(sessionCookieOptions().maxAge).toBe(SESSION_TTL_S);
	});

	it('keeps the security attributes when it is cleared, so the browser drops it', () => {
		const options = clearSessionCookieOptions();

		expect(options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
	});

	it('has a name that cannot be confused with an agent token', () => {
		expect(SESSION_COOKIE).toBe('ad_session');
	});
});

describe('signing and reading', () => {
	it('round-trips a session the same secret signed', () => {
		const now = 1_700_000_000_000;

		const session = readSession(signSession(SECRET, { now }), SECRET, now);

		expect(session).toEqual({ issuedAt: now, expiresAt: now + SESSION_TTL_S * 1000 });
	});

	it('rejects a cookie signed with a different secret, so rotating it logs the owner out', () => {
		const value = signSession(OTHER_SECRET);

		expect(readSession(value, SECRET)).toBeNull();
	});

	it('rejects a tampered payload', () => {
		const [payload, signature] = signSession(SECRET).split('.');
		const forged = Buffer.from(JSON.stringify({ issuedAt: 0, expiresAt: 9e15 })).toString(
			'base64url'
		);

		expect(readSession(`${forged}.${signature}`, SECRET)).toBeNull();
		expect(readSession(`${payload}.${signature}x`, SECRET)).toBeNull();
	});

	it('rejects a cookie past its expiry', () => {
		const now = 1_700_000_000_000;
		const value = signSession(SECRET, { now, ttlS: 60 });

		expect(readSession(value, SECRET, now + 59_000)).not.toBeNull();
		expect(readSession(value, SECRET, now + 61_000)).toBeNull();
	});

	it('rejects garbage instead of throwing', () => {
		for (const value of [undefined, null, '', 'nope', 'a.b.c', '.', `${'!'}.${'!'}`]) {
			expect(readSession(value, SECRET), String(value)).toBeNull();
		}
	});

	it('refuses to verify against an empty secret, so a missing SESSION_SECRET fails closed', () => {
		expect(readSession(signSession(SECRET), '')).toBeNull();
	});
});
