import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

// argon2id is deliberately slow. One shared hash keeps the suite honest without
// paying the cost per assertion.
const PASSWORD = 'correct horse battery staple';
const hash = await hashPassword(PASSWORD);

describe('the owner password', () => {
	it('hashes with argon2id, as the config schema demands', () => {
		expect(hash.startsWith('$argon2id$')).toBe(true);
	});

	it('accepts the password it was hashed from', async () => {
		await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
	});

	it('rejects the wrong password', async () => {
		await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
		await expect(verifyPassword('', hash)).resolves.toBe(false);
		await expect(verifyPassword(`${PASSWORD} `, hash)).resolves.toBe(false);
	});

	it('rejects rather than throws when the configured hash is not a hash at all', async () => {
		for (const bad of ['', 'plaintext-password', '$argon2id$broken']) {
			await expect(verifyPassword(PASSWORD, bad), bad).resolves.toBe(false);
		}
	});

	it('salts, so the same password never hashes twice the same way', async () => {
		await expect(hashPassword(PASSWORD)).resolves.not.toBe(hash);
	});
});
