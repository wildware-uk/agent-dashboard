import { describe, expect, it } from 'vitest';
import { mcpConfig } from './env';

const VALID = {
	ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
	SESSION_SECRET: 's'.repeat(32),
	TOKEN_SECRET: 't'.repeat(32)
};

describe('mcpConfig', () => {
	it('reads TOKEN_SECRET out of the environment', () => {
		expect(mcpConfig(VALID)).toMatchObject({ tokenSecret: 't'.repeat(32) });
	});

	it('carries the hold an owner request parks for, in milliseconds (design §5)', () => {
		expect(mcpConfig(VALID)?.holdMs).toBe(55_000);
		expect(mcpConfig({ ...VALID, HOLD_S: '20' })?.holdMs).toBe(20_000);
	});

	it('fails closed rather than throwing on a broken environment', () => {
		expect(mcpConfig({ ...VALID, TOKEN_SECRET: undefined })).toBeNull();
		expect(mcpConfig({ ...VALID, TOKEN_SECRET: 'too-short' })).toBeNull();
		expect(mcpConfig({})).toBeNull();
	});
});
