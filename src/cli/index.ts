/**
 * The operator CLI (design §10).
 *
 * Two of these commands have to run *before* the dashboard is usable at all —
 * `hash-password` produces `ADMIN_PASSWORD_HASH`, and `mint-token` creates the
 * first agent token, which nobody can do through a UI they cannot log into yet.
 * So this is a separate entry point into the same process, not an admin page.
 *
 * Everything here is a thin shell around functions that already exist:
 * `mintAgentToken`, `listAgents` and `revokeAgentToken` come from `$domain`, and
 * `hashPassword` from `$http/auth`. Nothing hashes, HMACs or writes a row in
 * this file — a token minted by the CLI and a token minted anywhere else must be
 * the same object, produced by the same code (design §8).
 *
 * `run()` takes its environment, its two output streams and its database opener
 * as arguments rather than reaching for `process`, so the tests drive the real
 * command table against an in-memory database. `bin.ts` is the only file that
 * touches `process`.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig, type Config, type RawEnv } from '$config';
import { closeDatabase, getDatabase, type Db } from '$db';
import {
	context,
	isDomainError,
	listAgents,
	mintAgentToken,
	revokeAgentToken,
	type DomainContext
} from '$domain';
import { hashPassword } from '$http/auth';

/** Everything a command may talk to. Nothing here reads `process` directly. */
export type CliIo = {
	/** The environment, validated by `$config` only when a command needs it. */
	env: RawEnv;
	/** One line to stdout. */
	out: (line: string) => void;
	/** One line to stderr. */
	err: (line: string) => void;
	/** Open the deployment's database. Defaults to the shared `DATA_DIR` one. */
	openDb?: (config: Config) => Db;
	/** Read stdin to end, for `hash-password --stdin`. */
	readStdin?: () => Promise<string>;
};

/** What the shell should exit with. */
const OK = 0;
/** The command ran and failed: bad configuration, no such agent, unwritable path. */
const FAILED = 1;
/** The command line itself was wrong. Usage goes to stderr, as usage does. */
const USAGE = 2;

type Command = {
	/** Argument list as it appears in the usage block. */
	args: string;
	summary: string;
	run: (argv: string[], io: CliIo) => Promise<number> | number;
};

/** Resolve the database and hand back a domain context bound to it. */
function domain(io: CliIo): DomainContext {
	const config = loadConfig(io.env);
	const open = io.openDb ?? ((c: Config) => getDatabase(c));
	return context({ db: open(config) });
}

function usageError(io: CliIo, message: string): number {
	io.err(message);
	io.err('');
	printUsage(io.err);
	return USAGE;
}

export const COMMANDS: Record<string, Command> = {
	'mint-token': {
		args: '<name>',
		summary: 'Create an agent and print its bearer token. Printed once, never stored.',
		run: (argv, io) => {
			const name = argv[0];
			if (!name) return usageError(io, 'mint-token needs a name, e.g. claude-code@laptop');

			const ctx = domain(io);
			const { agent, token } = mintAgentToken(ctx, {
				name,
				secret: loadConfig(io.env).TOKEN_SECRET
			});

			io.out(`agent ${agent.id}  ${agent.name}`);
			io.out(token);
			io.out('');
			io.out('This is the only time the token is shown. Store it in the agent MCP config.');
			return OK;
		}
	},

	'hash-password': {
		args: '<password> | --stdin',
		summary: 'Print an argon2id hash for ADMIN_PASSWORD_HASH.',
		run: async (argv, io) => {
			const first = argv[0];
			if (first === undefined || first === '') {
				return usageError(io, 'hash-password needs a password, or --stdin to read one');
			}

			let password = first;
			if (first === '--stdin') {
				const read = io.readStdin;
				if (!read) return usageError(io, 'hash-password --stdin has nothing to read from');
				// A trailing newline is the shell's, not part of the password.
				password = (await read()).replace(/\r?\n$/, '');
				if (password === '') return usageError(io, 'hash-password read an empty password');
			}

			io.out(await hashPassword(password));
			io.out('');
			io.out("Quote it in .env — the hash contains '$', which a shell would expand.");
			return OK;
		}
	},

	'list-tokens': {
		args: '[--revoked]',
		summary: 'List agents and when they were last seen. Tokens are not recoverable.',
		run: (argv, io) => {
			const includeRevoked = argv.includes('--revoked');
			const agents = listAgents(domain(io), { includeRevoked });
			if (agents.length === 0) {
				io.out('no agents yet — mint one with: mint-token <name>');
				return OK;
			}

			for (const agent of agents) {
				const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt).toISOString() : 'never seen';
				const state = agent.revokedAt ? '  REVOKED' : '';
				io.out(`${agent.id}  ${agent.name}  (${seen})${state}`);
			}
			return OK;
		}
	},

	'revoke-token': {
		args: '<agent-id>',
		summary: 'Switch an agent token off for good.',
		run: (argv, io) => {
			const id = argv[0];
			if (!id) return usageError(io, 'revoke-token needs an agent id (see list-tokens)');

			const revoked = revokeAgentToken(domain(io), id);
			io.out(revoked ? `revoked ${id}` : `${id} was already revoked`);
			return OK;
		}
	},

	backup: {
		args: '<destination.db>',
		summary: 'Online backup of the database, safe while the server is running.',
		run: async (argv, io) => {
			const destination = argv[0];
			if (!destination) return usageError(io, 'backup needs a destination file path');

			const target = resolve(destination);
			mkdirSync(dirname(target), { recursive: true });
			// The driver's own online backup: consistent against a live WAL database,
			// which a `cp` of the file is not. Media is not in here — see the README.
			await domain(io).db.backup(target);

			io.out(`wrote ${target}`);
			io.out('Media lives outside the database; rsync DATA_DIR/media/ as well.');
			return OK;
		}
	},

	help: {
		args: '',
		summary: 'Print this usage.',
		run: (_argv, io) => {
			printUsage(io.out);
			return OK;
		}
	}
};

const NAME_COLUMN = Math.max(
	...Object.entries(COMMANDS).map(([name, command]) => `${name} ${command.args}`.trim().length)
);

function printUsage(write: (line: string) => void): void {
	write('agent-dashboard <command> [arguments]');
	write('');
	for (const [name, command] of Object.entries(COMMANDS)) {
		const invocation = `${name} ${command.args}`.trim();
		write(`  ${invocation.padEnd(NAME_COLUMN)}  ${command.summary}`);
	}
	write('');
	write('Configuration is read from the environment; see .env.example.');
}

/**
 * Run one command.
 *
 * @param argv arguments after the program name.
 * @returns the process exit code: 0 fine, 1 the command failed, 2 the command
 *   line was wrong.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
	const [name, ...rest] = argv;
	if (name === '--help' || name === '-h') {
		printUsage(io.out);
		return OK;
	}
	if (name === undefined || name === '') return usageError(io, 'no command given');

	const command = COMMANDS[name];
	if (!command) return usageError(io, `unknown command: ${name}`);

	try {
		return await command.run(rest, io);
	} catch (error) {
		// A misconfigured deployment and a typo'd agent id are both ordinary
		// outcomes here, and both already carry a message written for a human. A
		// stack trace would bury it, so only genuinely unexpected errors get one.
		if (isDomainError(error) || error instanceof Error) {
			io.err(error.message);
			if (!isDomainError(error) && !/^Invalid configuration:/.test(error.message)) {
				io.err(String(error.stack ?? ''));
			}
			return FAILED;
		}
		io.err(String(error));
		return FAILED;
	} finally {
		// Only ever closes the process-wide handle this CLI opened; a test that
		// injected its own database keeps it.
		if (!io.openDb) closeDatabase();
	}
}
