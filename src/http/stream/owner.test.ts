import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse } from './owner';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

function cookies(value?: string) {
	return { cookies: { get: (name: string) => (name === SESSION_COOKIE ? value : undefined) } };
}

describe('the owner check the live endpoints repeat for themselves', () => {
	it('accepts a request carrying a valid session cookie', () => {
		expect(ownerAuthenticated(cookies(signSession(SESSION_SECRET)), config)).toBe(true);
	});

	it('refuses a request with no cookie', () => {
		expect(ownerAuthenticated(cookies(), config)).toBe(false);
	});

	it('refuses a cookie signed with another secret', () => {
		expect(ownerAuthenticated(cookies(signSession('x'.repeat(32))), config)).toBe(false);
	});

	it('fails closed when the environment does not validate', () => {
		expect(ownerAuthenticated(cookies(signSession(SESSION_SECRET)), () => null)).toBe(false);
	});
});

describe('the refusal', () => {
	it('is the 401 JSON shape the hook already sends', async () => {
		const response = unauthenticatedResponse();

		expect(response.status).toBe(401);
		expect(response.headers.get('content-type')).toBe('application/json');
		await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' });
	});
});
