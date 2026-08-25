import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARS, loadConfig } from './config';

/** The minimum an operator must set; everything else has a default. */
const required = {
	ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA',
	SESSION_SECRET: 's'.repeat(32),
	TOKEN_SECRET: 't'.repeat(32)
};

describe('loadConfig', () => {
	it('applies documented defaults when only the secrets are set', () => {
		const config = loadConfig(required);

		expect(config).toMatchObject({
			DATA_DIR: 'data',
			PUBLIC_BASE_URL: 'http://localhost:5173',
			MAX_IMAGE_BYTES: 10 * 1024 * 1024,
			MAX_VIDEO_BYTES: 200 * 1024 * 1024,
			HOLD_S: 55
		});
	});

	it('coerces the numeric vars out of their string env values', () => {
		const config = loadConfig({ ...required, MAX_IMAGE_BYTES: '1234', HOLD_S: '30' });

		expect(config.MAX_IMAGE_BYTES).toBe(1234);
		expect(config.HOLD_S).toBe(30);
	});

	it.each(Object.keys(required))('rejects a missing %s', (name) => {
		const env = { ...required, [name]: undefined };

		expect(() => loadConfig(env)).toThrow(name);
	});

	it('rejects secrets that are too short to be secrets', () => {
		expect(() => loadConfig({ ...required, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
	});

	it('rejects a hold longer than the 60s client tool timeout it must duck under', () => {
		// design §5: the bounded long-poll is deliberately under 60s.
		expect(() => loadConfig({ ...required, HOLD_S: '60' })).toThrow(/HOLD_S/);
	});

	it('rejects a PUBLIC_BASE_URL that is not an absolute URL', () => {
		expect(() => loadConfig({ ...required, PUBLIC_BASE_URL: 'localhost:3000' })).toThrow(
			/PUBLIC_BASE_URL/
		);
	});

	it('strips a trailing slash from PUBLIC_BASE_URL so callers can concatenate paths', () => {
		expect(loadConfig({ ...required, PUBLIC_BASE_URL: 'https://x.test/' }).PUBLIC_BASE_URL).toBe(
			'https://x.test'
		);
	});

	it('reports every variable it understands, for .env.example to be checked against', () => {
		expect(CONFIG_VARS).toEqual([
			'DATA_DIR',
			'ADMIN_PASSWORD_HASH',
			'SESSION_SECRET',
			'TOKEN_SECRET',
			'PUBLIC_BASE_URL',
			'MAX_IMAGE_BYTES',
			'MAX_VIDEO_BYTES',
			'HOLD_S'
		]);
	});
});

describe('.env.example', () => {
	const example = readFileSync(resolve(import.meta.dirname, '..', '.env.example'), 'utf8');
	const documented = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

	it.each(CONFIG_VARS)('documents %s', (name) => {
		expect(documented).toContain(name);
	});

	it('documents nothing loadConfig would ignore', () => {
		// Vars the Node adapter reads rather than us are listed under their own
		// heading and are allowed; anything else is a var that silently does nothing.
		const adapterVars = ['PORT', 'HOST', 'ORIGIN', 'BODY_SIZE_LIMIT', 'NODE_ENV'];
		const stray = documented.filter(
			(name) => !CONFIG_VARS.includes(name as never) && !adapterVars.includes(name)
		);

		expect(stray).toEqual([]);
	});
});
