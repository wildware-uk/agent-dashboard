/**
 * The SQLite connection (design §2, §3).
 *
 * This is the only file in the tree that imports the driver; everything else
 * takes a `Db` handle as an argument. `src/architecture.test.ts` keeps other
 * modules out of `src/db`, and `connection.test.ts` keeps the driver import
 * inside this file.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, type Config } from '$config';
import { migrate } from './migrate';

/** The driver handle. Repositories and the domain speak in terms of this type. */
export type Db = Database.Database;

/** File name of the database inside `DATA_DIR`. */
export const DATABASE_FILE = 'agent-dashboard.db';

/** An in-memory database: no file, no WAL, gone when the handle closes. */
export const MEMORY = ':memory:';

export type OpenOptions = {
	/** Path to the database file, or `:memory:`. */
	file: string;
	/** Apply pending migrations on open. Default `true`. */
	migrate?: boolean;
	/** Statement logger, handy when debugging a test. */
	verbose?: (message?: unknown, ...rest: unknown[]) => void;
};

/** Where the database lives for a given data directory (design §10: `DATA_DIR`). */
export function databaseFile(dataDir: string): string {
	return join(dataDir, DATABASE_FILE);
}

/**
 * Open a connection with this app's pragmas, and by default bring it up to the
 * current schema.
 *
 * WAL matters here: one process serves the browser, the MCP surface, and the
 * background sweepers at once, and WAL is what lets readers keep reading while
 * an update is written. It is skipped for `:memory:`, which has no journal file
 * to write.
 */
export function openDatabase(options: OpenOptions): Db {
	const file = options.file;
	if (file !== MEMORY) mkdirSync(dirname(file), { recursive: true });

	const db = new Database(file, options.verbose ? { verbose: options.verbose } : {});

	if (file !== MEMORY) {
		db.pragma('journal_mode = WAL');
		// Durable enough with WAL: a crash can lose the last commit, not the file.
		db.pragma('synchronous = NORMAL');
	}
	// Off by default in SQLite, and the schema leans on it heavily.
	db.pragma('foreign_keys = ON');
	// Wait rather than throw SQLITE_BUSY when a writer holds the lock.
	db.pragma('busy_timeout = 5000');

	if (options.migrate !== false) migrate(db);

	return db;
}

let shared: Db | undefined;

/**
 * The process-wide connection, opened from `DATA_DIR` on first use and migrated
 * to the current schema.
 *
 * One connection for the process is correct for better-sqlite3: it is
 * synchronous, so there is nothing to pool.
 */
export function getDatabase(config?: Config): Db {
	if (!shared) {
		const { DATA_DIR } = config ?? loadConfig(process.env);
		shared = openDatabase({ file: databaseFile(DATA_DIR) });
	}
	return shared;
}

/** Close the shared connection, if one was opened. For shutdown and for tests. */
export function closeDatabase(): void {
	shared?.close();
	shared = undefined;
}
