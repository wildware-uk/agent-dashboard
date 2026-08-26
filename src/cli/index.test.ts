import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticateAgent, context, listAgents } from '$domain';
import { openDatabase, MEMORY, type Db } from '$db';
import { verifyPassword } from '$http/auth';
import { COMMANDS, run, type CliIo } from './index';

const HASH =
	'$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$0000000000000000000000000000000000000000000';

const ENV = {
	DATA_DIR: 'data',
	ADMIN_PASSWORD_HASH: HASH,
	SESSION_SECRET: 's'.repeat(32),
	TOKEN_SECRET: 't'.repeat(32)
};

const temporaries: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'agent-dashboard-cli-'));
	temporaries.push(dir);
	return dir;
}

afterEach(() => {
	while (temporaries.length) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

/** A CLI wired to an in-memory database, with its two streams captured. */
function harness(env: Record<string, string | undefined> = ENV) {
	const out: string[] = [];
	const err: string[] = [];
	let db: Db | undefined;

	const io: CliIo = {
		env,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		openDb: () => (db ??= openDatabase({ file: MEMORY }))
	};

	return {
		io,
		out,
		err,
		stdout: () => out.join('\n'),
		stderr: () => err.join('\n'),
		db: () => db!,
		run: (...argv: string[]) => run(argv, io)
	};
}

describe('mint-token', () => {
	it('prints a token that authenticates as the named agent', async () => {
		const cli = harness();

		expect(await cli.run('mint-token', 'claude-code@laptop')).toBe(0);

		const token = cli.stdout().match(/[A-Za-z0-9_-]{43}/)?.[0];
		expect(token, cli.stdout()).toBeDefined();

		const auth = authenticateAgent(context({ db: cli.db() }), {
			token: token!,
			secret: ENV.TOKEN_SECRET
		});
		expect(auth.ok).toBe(true);
		expect(auth.ok && auth.agent.name).toBe('claude-code@laptop');
	});

	it('names the variable when a required secret is missing, and mints nothing', async () => {
		const cli = harness({ ...ENV, TOKEN_SECRET: undefined });

		expect(await cli.run('mint-token', 'laptop')).toBe(1);
		expect(cli.stderr()).toContain('TOKEN_SECRET');
		expect(cli.stdout()).toBe('');
	});

	it('refuses without a name rather than minting an unnamed token', async () => {
		const cli = harness();

		expect(await cli.run('mint-token')).toBe(2);
		expect(cli.stderr()).toMatch(/usage/i);
		expect(cli.stdout()).toBe('');
	});
});

describe('hash-password', () => {
	it('prints an argon2id hash the login path accepts', async () => {
		const cli = harness();

		expect(await cli.run('hash-password', 'correct horse')).toBe(0);

		const hash = cli.out.find((line) => line.startsWith('$argon2id$'));
		expect(hash, cli.stdout()).toBeDefined();
		await expect(verifyPassword('correct horse', hash!)).resolves.toBe(true);
		await expect(verifyPassword('wrong horse', hash!)).resolves.toBe(false);
	});

	it('works with no configuration at all, since it runs before there is any', async () => {
		const cli = harness({});

		expect(await cli.run('hash-password', 'hunter2')).toBe(0);
		expect(cli.stdout()).toContain('$argon2id$');
	});

	it('reads the password from stdin when asked, so it stays out of shell history', async () => {
		const cli = harness();
		cli.io.readStdin = () => Promise.resolve('from-stdin\n');

		expect(await cli.run('hash-password', '--stdin')).toBe(0);

		const hash = cli.out.find((line) => line.startsWith('$argon2id$'))!;
		await expect(verifyPassword('from-stdin', hash)).resolves.toBe(true);
	});
});

describe('list-tokens', () => {
	it('lists agents by id and name, and never a token', async () => {
		const cli = harness();
		await cli.run('mint-token', 'laptop');
		const token = cli.stdout().match(/[A-Za-z0-9_-]{43}/)![0];
		cli.out.length = 0;

		expect(await cli.run('list-tokens')).toBe(0);

		const [agent] = listAgents(context({ db: cli.db() }));
		expect(cli.stdout()).toContain(agent.id);
		expect(cli.stdout()).toContain('laptop');
		expect(cli.stdout()).not.toContain(token);
	});
});

describe('revoke-token', () => {
	it('switches a token off', async () => {
		const cli = harness();
		await cli.run('mint-token', 'laptop');
		const token = cli.stdout().match(/[A-Za-z0-9_-]{43}/)![0];
		const [agent] = listAgents(context({ db: cli.db() }));

		expect(await cli.run('revoke-token', agent.id)).toBe(0);

		const auth = authenticateAgent(context({ db: cli.db() }), {
			token,
			secret: ENV.TOKEN_SECRET
		});
		expect(auth.ok).toBe(false);
		expect(!auth.ok && auth.reason).toBe('revoked_token');
	});

	it('fails loudly on an id that does not exist', async () => {
		const cli = harness();

		expect(await cli.run('revoke-token', 'nope')).toBe(1);
		expect(cli.stderr()).toContain('nope');
	});
});

describe('backup', () => {
	it('writes a copy that opens and still holds the agents', async () => {
		const cli = harness();
		await cli.run('mint-token', 'laptop');
		const destination = join(tempDir(), 'nested', 'backup.db');

		expect(await cli.run('backup', destination)).toBe(0);
		expect(existsSync(destination)).toBe(true);

		const restored = openDatabase({ file: destination, migrate: false });
		try {
			expect(listAgents(context({ db: restored })).map((a) => a.name)).toEqual(['laptop']);
		} finally {
			restored.close();
		}
	});

	it('refuses without a destination', async () => {
		const cli = harness();

		expect(await cli.run('backup')).toBe(2);
		expect(cli.stderr()).toMatch(/usage/i);
	});
});

describe('usage', () => {
	it('documents every command it accepts', async () => {
		const cli = harness();

		expect(await cli.run('help')).toBe(0);
		for (const name of Object.keys(COMMANDS)) expect(cli.stdout()).toContain(name);
	});

	it('prints usage and fails when given no command', async () => {
		const cli = harness();

		expect(await cli.run()).toBe(2);
		expect(cli.stderr()).toMatch(/usage/i);
	});

	it('names the offending word on an unknown command', async () => {
		const cli = harness();

		expect(await cli.run('mint-tokens')).toBe(2);
		expect(cli.stderr()).toContain('mint-tokens');
	});
});

describe('the shipped documentation', () => {
	const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

	it('names every command', () => {
		for (const name of Object.keys(COMMANDS)) expect(readme).toContain(name);
	});
});
