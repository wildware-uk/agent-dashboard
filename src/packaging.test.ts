/**
 * The packaging artefacts (design §10), as executable expectations.
 *
 * These files are the only part of the product a stranger meets before anything
 * runs, and none of them is exercised by another test: a Dockerfile that forgets
 * ffmpeg or a compose file that loses the data volume both look fine in review
 * and fail in production. So the invariants that would cost an outage are
 * asserted here rather than remembered.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARS } from './config';

const ROOT = resolve(import.meta.dirname, '..');
const read = (name: string) => readFileSync(resolve(ROOT, name), 'utf8');

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const compose = read('docker-compose.yml');
const readme = read('README.md');
const envExample = read('.env.example');
/**
 * The README with backticks dropped and whitespace collapsed, so an assertion
 * about what it *says* does not fail on where prettier wrapped a line or whether
 * a term happened to be in code font.
 */
const prose = readme.replace(/`/g, '').replace(/\s+/g, ' ');

/** The three values that must never have a default anywhere in the packaging. */
const SECRETS = ['ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'TOKEN_SECRET'] as const;

describe('Dockerfile', () => {
	it('is built on node:22-slim', () => {
		expect(dockerfile).toMatch(/^FROM node:22-slim/m);
	});

	it('installs ffmpeg, which the derivative pipeline shells out to', () => {
		expect(dockerfile).toMatch(/apt-get install[^\n]*ffmpeg|ffmpeg[^\n]*\\/);
	});

	it('builds the CLI as well as the server, so the first token can be minted', () => {
		expect(dockerfile).toMatch(/build:cli|build:all/);
	});

	it('serves on the documented default port', () => {
		expect(dockerfile).toMatch(/ENV[^\n]*PORT=8010|PORT=8010/);
	});

	it('runs the built server', () => {
		expect(dockerfile).toMatch(/CMD \["node", "build"\]/);
	});

	it('never bakes a secret in, so a missing one still aborts startup', () => {
		for (const secret of SECRETS) {
			expect(dockerfile, secret).not.toMatch(new RegExp(`ENV[^\\n]*${secret}\\s*=`));
			expect(dockerfile, secret).not.toMatch(new RegExp(`^${secret}=`, 'm'));
		}
	});

	it('runs as a non-root user', () => {
		expect(dockerfile).toMatch(/^USER (?!root)/m);
	});
});

describe('.dockerignore', () => {
	it('keeps the local deployment secrets and data out of the image', () => {
		for (const path of ['.local', '.env', 'node_modules', 'data']) {
			expect(dockerignore.split('\n').map((l) => l.trim())).toContain(path);
		}
	});
});

describe('docker-compose.yml', () => {
	it('keeps the data directory on a named volume, so a recreate does not lose it', () => {
		expect(compose).toMatch(/^volumes:/m);
		expect(compose).toMatch(/agent-dashboard-data/);
	});

	it('points DATA_DIR at that volume', () => {
		expect(compose).toMatch(/DATA_DIR:\s*\/data/);
		expect(compose).toMatch(/agent-dashboard-data:\/data/);
	});

	it('reads configuration from .env rather than hard-coding it', () => {
		expect(compose).toMatch(/env_file/);
		expect(compose).toMatch(/\.env/);
	});

	it('sets ORIGIN from PUBLIC_BASE_URL, or a browser login is refused by CSRF', () => {
		expect(compose).toMatch(/ORIGIN:\s*\$\{PUBLIC_BASE_URL/);
	});

	it('carries no secret of its own', () => {
		for (const secret of SECRETS) {
			expect(compose, secret).not.toMatch(new RegExp(`${secret}:\\s*['"]?\\S`));
		}
	});
});

describe('.env.example', () => {
	/**
	 * adapter-node does not treat `ADDRESS_HEADER` as a hint. Once it is set,
	 * every request that arrives *without* that header makes `getClientAddress()`
	 * throw, so a `docker compose up` with nothing proxying yet answers the login
	 * POST with a 500. It has to be commented out by default and turned on with
	 * the proxy — which is safe, because `assertClientAddressTrustworthy` refuses
	 * to boot an https deployment that has not.
	 */
	it('ships the forwarded-address vars commented out, so a direct request works', () => {
		expect(envExample).toMatch(/^#\s*ADDRESS_HEADER=/m);
		expect(envExample).toMatch(/^#\s*XFF_DEPTH=/m);
		expect(envExample).not.toMatch(/^ADDRESS_HEADER=/m);
		expect(envExample).not.toMatch(/^XFF_DEPTH=/m);
	});
});

describe('README', () => {
	it('states the scope honestly', () => {
		expect(readme).toMatch(/single[- ]owner/i);
		expect(readme).toMatch(/multi-tenan/i);
	});

	it('documents every configuration variable the app reads', () => {
		for (const name of CONFIG_VARS) expect(readme, name).toContain(name);
	});

	it('gives a copy-paste MCP client configuration', () => {
		expect(readme).toMatch(/claude mcp add|mcpServers/);
		expect(readme).toMatch(/\/mcp/);
		expect(readme).toMatch(/Authorization/);
		expect(readme).toMatch(/Bearer/);
	});

	it('keeps the reverse-proxy rules that make SSE work', () => {
		expect(readme).toMatch(/flush_interval -1/);
		expect(readme).toMatch(/proxy_buffering off/);
	});

	it('documents a backup that does not need the sqlite3 CLI', () => {
		expect(prose).toMatch(/agent-dashboard backup/);
		expect(prose).toMatch(/sqlite3 CLI is not required/i);
		expect(prose).toMatch(/rsync/);
	});

	it('warns that building into the directory being served kills the server', () => {
		const section = prose.slice(prose.search(/upgrad/i));
		expect(section).toMatch(/build/i);
		expect(section).toMatch(/swap|replace|rename/i);
	});

	it('warns that PUBLIC_BASE_URL must be reachable by the agent', () => {
		expect(prose).toMatch(/cannot upload anything/i);
		expect(prose).toMatch(/\/etc\/hosts/);
		expect(prose).toMatch(/resolve/i);
	});

	it('explains the 500 that ADDRESS_HEADER causes without a proxy', () => {
		expect(prose).toMatch(/Address header was specified/);
	});

	it('tells the operator how to mint the first token', () => {
		expect(readme).toMatch(/mint-token/);
		expect(readme).toMatch(/hash-password/);
	});
});
