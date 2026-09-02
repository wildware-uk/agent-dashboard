import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assertBodyLimitAllowsUploads,
	assertClientAddressTrustworthy,
	CONFIG_VARS,
	loadConfig,
	parseBodySizeLimit,
	pushConfig
} from './config';

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
			'HOLD_S',
			'VAPID_PUBLIC_KEY',
			'VAPID_PRIVATE_KEY',
			'VAPID_SUBJECT'
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
		const adapterVars = [
			'PORT',
			'HOST',
			'ORIGIN',
			'BODY_SIZE_LIMIT',
			'NODE_ENV',
			// Deliberately outside CONFIG_VARS: the adapter reads these two to work
			// out the client address, and TRUST_SOCKET_ADDRESS only gates the boot
			// check in assertClientAddressTrustworthy. None reach loadConfig.
			'ADDRESS_HEADER',
			'XFF_DEPTH',
			'TRUST_SOCKET_ADDRESS'
		];
		const stray = documented.filter(
			(name) => !CONFIG_VARS.includes(name as never) && !adapterVars.includes(name)
		);

		expect(stray).toEqual([]);
	});
});

describe('assertClientAddressTrustworthy', () => {
	const proxied = { PUBLIC_BASE_URL: 'https://agents.wildware.dev' };

	it('refuses a proxied deployment that would share one rate-limit bucket', () => {
		expect(() => assertClientAddressTrustworthy(proxied)).toThrow(/ADDRESS_HEADER is unset/);
	});

	it('accepts a proxied deployment that forwards the client address', () => {
		expect(() =>
			assertClientAddressTrustworthy({ ...proxied, ADDRESS_HEADER: 'X-Forwarded-For' })
		).not.toThrow();
	});

	it('accepts an explicit acknowledgement that the socket peer is the client', () => {
		expect(() =>
			assertClientAddressTrustworthy({ ...proxied, TRUST_SOCKET_ADDRESS: 'true' })
		).not.toThrow();
	});

	it('leaves plain-http development alone', () => {
		expect(() =>
			assertClientAddressTrustworthy({ PUBLIC_BASE_URL: 'http://localhost:8010' })
		).not.toThrow();
	});

	it('treats an empty ADDRESS_HEADER as unset', () => {
		expect(() => assertClientAddressTrustworthy({ ...proxied, ADDRESS_HEADER: '' })).toThrow(
			/ADDRESS_HEADER is unset/
		);
	});
});

describe('parseBodySizeLimit', () => {
	it.each([
		['512K', 524288],
		['200M', 209715200],
		['1G', 1073741824],
		['1024', 1024]
	])('reads %s as %i bytes', (raw, bytes) => {
		expect(parseBodySizeLimit(raw)).toBe(bytes);
	});

	it('returns null for a value the adapter would reject itself', () => {
		expect(parseBodySizeLimit('lots')).toBeNull();
	});
});

describe('assertBodyLimitAllowsUploads', () => {
	const config = loadConfig(required);

	it('refuses the adapter default, which is far below the upload caps', () => {
		// The common case: a deployment that never sets BODY_SIZE_LIMIT at all.
		expect(() => assertBodyLimitAllowsUploads({}, config)).toThrow(/BODY_SIZE_LIMIT is 512K/);
	});

	it('refuses a value below the largest accepted upload', () => {
		expect(() => assertBodyLimitAllowsUploads({ BODY_SIZE_LIMIT: '1M' }, config)).toThrow(
			/adapter-node enforces BODY_SIZE_LIMIT/
		);
	});

	it('accepts a value at least as large as the biggest upload', () => {
		const enough = String(Math.max(config.MAX_IMAGE_BYTES, config.MAX_VIDEO_BYTES));
		expect(() => assertBodyLimitAllowsUploads({ BODY_SIZE_LIMIT: enough }, config)).not.toThrow();
	});

	it('leaves an unparseable value for the adapter to complain about', () => {
		expect(() => assertBodyLimitAllowsUploads({ BODY_SIZE_LIMIT: 'lots' }, config)).not.toThrow();
	});
});

/**
 * Push is optional, and half-configured is a mistake rather than a preference
 * (design §7). A deployment that set one key plainly meant to switch it on.
 */
describe('push notifications', () => {
	const keys = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };

	it('is off when no keypair is set, which is a valid deployment', () => {
		expect(pushConfig(loadConfig(required))).toBeNull();
	});

	it('is on when both keys are set', () => {
		expect(pushConfig(loadConfig({ ...required, ...keys }))).toMatchObject({
			publicKey: 'pub',
			privateKey: 'priv'
		});
	});

	it('refuses to start on half a keypair rather than quietly disabling push', () => {
		expect(() => loadConfig({ ...required, VAPID_PUBLIC_KEY: 'pub' })).toThrow(/together/);
		expect(() => loadConfig({ ...required, VAPID_PRIVATE_KEY: 'priv' })).toThrow(/together/);
	});

	it('addresses complaints to this deployment when no subject is given', () => {
		const config = loadConfig({ ...required, ...keys, PUBLIC_BASE_URL: 'https://agents.test' });

		expect(pushConfig(config)?.subject).toBe('https://agents.test');
	});

	it('takes a mailto: or an https: subject, and nothing else', () => {
		expect(
			pushConfig(loadConfig({ ...required, ...keys, VAPID_SUBJECT: 'mailto:o@example.com' }))
				?.subject
		).toBe('mailto:o@example.com');
		expect(() => loadConfig({ ...required, ...keys, VAPID_SUBJECT: 'owner@example.com' })).toThrow(
			/mailto:/
		);
	});
});
