import { describe, expect, it } from 'vitest';
import { authConfig } from './env';

const VALID = {
	ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
	SESSION_SECRET: 's'.repeat(32),
	TOKEN_SECRET: 't'.repeat(32)
};

describe('the auth configuration', () => {
	it('hands back the two values auth needs', () => {
		expect(authConfig(VALID)).toEqual({
			sessionSecret: VALID.SESSION_SECRET,
			adminPasswordHash: VALID.ADMIN_PASSWORD_HASH
		});
	});

	it('is absent — not thrown — when the environment will not do', () => {
		const cases: Record<string, Record<string, string | undefined>> = {
			'nothing set': {},
			'no password hash': { ...VALID, ADMIN_PASSWORD_HASH: undefined },
			'no session secret': { ...VALID, SESSION_SECRET: undefined },
			'a bcrypt hash': { ...VALID, ADMIN_PASSWORD_HASH: '$2b$12$abcdefghijklmnop' },
			'a short session secret': { ...VALID, SESSION_SECRET: 'too-short' }
		};

		for (const [name, env] of Object.entries(cases)) {
			expect(authConfig(env), name).toBeNull();
		}
	});
});
