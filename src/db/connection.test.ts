import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	closeDatabase,
	databaseFile,
	getDatabase,
	openDatabase,
	DATABASE_FILE,
	MEMORY
} from './connection';
import { loadConfig } from '$config';
import { appliedMigrations } from './migrate';

const tempDataDir = () => mkdtempSync(join(tmpdir(), 'agent-dashboard-db-'));

afterEach(() => closeDatabase());

describe('databaseFile', () => {
	it('puts the database inside DATA_DIR', () => {
		expect(databaseFile('/srv/data')).toBe(join('/srv/data', DATABASE_FILE));
	});
});

describe('openDatabase', () => {
	it('opens a file database in WAL mode', () => {
		const db = openDatabase({ file: databaseFile(tempDataDir()) });

		expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
		db.close();
	});

	it('creates the data directory when it does not exist yet', () => {
		const file = databaseFile(join(tempDataDir(), 'nested', 'deeper'));

		const db = openDatabase({ file });

		expect(statSync(file).isFile()).toBe(true);
		db.close();
	});

	it('enforces foreign keys', () => {
		const db = openDatabase({ file: MEMORY });

		expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
		db.close();
	});

	it('migrates to the current schema by default', () => {
		const db = openDatabase({ file: MEMORY });

		expect(appliedMigrations(db).length).toBeGreaterThan(0);
		db.close();
	});

	it('leaves the database empty when asked not to migrate', () => {
		const db = openDatabase({ file: MEMORY, migrate: false });

		expect(appliedMigrations(db)).toEqual([]);
		db.close();
	});

	it('reopens an existing file without re-applying its migrations', () => {
		const file = databaseFile(tempDataDir());
		const first = openDatabase({ file });
		const applied = appliedMigrations(first);
		first.close();

		const second = openDatabase({ file });

		expect(appliedMigrations(second)).toEqual(applied);
		second.close();
	});
});

describe('getDatabase', () => {
	/** The minimum a deployment must set, plus wherever we want the file. */
	const configFor = (dataDir: string) =>
		loadConfig({
			DATA_DIR: dataDir,
			ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaA',
			SESSION_SECRET: 's'.repeat(32),
			TOKEN_SECRET: 't'.repeat(32)
		});

	it('opens one migrated connection from DATA_DIR and reuses it', () => {
		const dataDir = tempDataDir();

		const db = getDatabase(configFor(dataDir));

		expect(getDatabase()).toBe(db);
		expect(appliedMigrations(db).length).toBeGreaterThan(0);
		expect(readdirSync(dataDir)).toContain(DATABASE_FILE);
	});

	it('opens a new connection after the shared one is closed', () => {
		const config = configFor(tempDataDir());
		const first = getDatabase(config);

		closeDatabase();

		expect(getDatabase(config)).not.toBe(first);
	});
});

/**
 * Acceptance criterion from issue #2: no file outside `src/db/` imports the
 * SQLite driver — and inside `src/db/`, only the connection does.
 */
describe('the driver import boundary', () => {
	const SRC = resolve(import.meta.dirname, '..');

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules') continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
			else if (/\.(ts|js|svelte)$/.test(entry)) out.push(full);
		}
		return out;
	}

	const importers = sourceFiles(SRC)
		.filter((file) => /better-sqlite3/.test(readFileSync(file, 'utf8')))
		.map((file) => relative(SRC, file).split(/[\\/]/).join('/'));

	it('is only crossed by src/db/connection.ts', () => {
		expect(importers.sort()).toEqual(['db/connection.test.ts', 'db/connection.ts']);
	});
});
