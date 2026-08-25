/**
 * Test support for every slice that touches the database (design §9).
 *
 * Domain, media, and MCP tests all want "a database that looks exactly like a
 * fresh deployment, and costs nothing". That is this: an in-memory SQLite with
 * every migration applied, isolated per call.
 *
 * This is a public entry point of `$db` alongside `index.ts`; import it as
 * `$db/testing` so nothing here is reachable from production code paths.
 */
import { MEMORY, openDatabase, type Db } from './connection';
import { migrate } from './migrate';

export type { Db };

/**
 * A brand new in-memory database with the full schema applied.
 *
 * Each call is a separate database — two handles never see each other's rows —
 * so tests can hold one per case with no cleanup beyond letting it fall out of
 * scope. Close it if the test creates many.
 */
export function freshDatabase(): Db {
	return openDatabase({ file: MEMORY });
}

/**
 * Run `body` against a fresh database and close it afterwards, even on failure.
 *
 * Use this when a test creates enough databases that leaking handles would
 * matter; `freshDatabase()` alone is fine for a single one.
 */
export function withDatabase<T>(body: (db: Db) => T): T {
	const db = freshDatabase();
	try {
		return body(db);
	} finally {
		db.close();
	}
}

/** Apply migrations to a handle a test opened itself. Re-exported for convenience. */
export { migrate };
