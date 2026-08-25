import { describe, expect, it } from 'vitest';
import { mcpConfig } from './env';

const VALID = {
	ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
	SESSION_SECRET: 's'.repeat(32),
	TOKEN_SECRET: 't'.repeat(32)
};

describe('mcpConfig', () => {
	it('reads TOKEN_SECRET out of the environment', () => {
		expect(mcpConfig(VALID)).toEqual({ tokenSecret: 't'.repeat(32) });
	});

	it('fails closed rather than throwing on a broken environment', () => {
		expect(mcpConfig({ ...VALID, TOKEN_SECRET: undefined })).toBeNull();
		expect(mcpConfig({ ...VALID, TOKEN_SECRET: 'too-short' })).toBeNull();
		expect(mcpConfig({})).toBeNull();
	});
});
