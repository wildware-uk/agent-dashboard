/**
 * The migration runner (design §11 step 2).
 *
 * Numbered migrations, applied in order, each in its own transaction, with what
 * was applied recorded in `schema_migrations`. Running it on an up-to-date
 * database is a no-op, so it is safe to call on every boot.
 */
import { createHash } from 'node:crypto';
import type { Db } from './connection';
import { MIGRATIONS, type Migration } from './migrations';
import { MIGRATIONS_TABLE } from './schema';

export type { Migration };

/** A row of `schema_migrations`: proof of what this database has had done to it. */
export type AppliedMigration = {
	version: number;
	name: string;
	/** sha256 of the migration's SQL, so an edited migration is detectable. */
	checksum: string;
	/** Milliseconds since the epoch. */
	appliedAt: number;
};

function checksum(sql: string): string {
	return createHash('sha256').update(sql).digest('hex');
}

function ensureMigrationsTable(db: Db): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			checksum TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		) STRICT;
	`);
}

/** What this database has already had applied, oldest first. */
export function appliedMigrations(db: Db): AppliedMigration[] {
	ensureMigrationsTable(db);
	return db
		.prepare<[], { version: number; name: string; checksum: string; applied_at: number }>(
			`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`
		)
		.all()
		.map((row) => ({
			version: row.version,
			name: row.name,
			checksum: row.checksum,
			appliedAt: row.applied_at
		}));
}

function assertUsable(migrations: readonly Migration[], applied: AppliedMigration[]): void {
	const seen = new Set<number>();
	for (const migration of migrations) {
		if (seen.has(migration.version)) {
			throw new Error(`Migration list has a duplicate version ${migration.version}`);
		}
		seen.add(migration.version);
	}

	const byVersion = new Map(migrations.map((m) => [m.version, m]));
	for (const row of applied) {
		const migration = byVersion.get(row.version);
		if (!migration) {
			throw new Error(
				`The database has migration version ${row.version} (${row.name}) applied, ` +
					`but this build does not have it. Refusing to run against a newer database.`
			);
		}
		if (checksum(migration.sql) !== row.checksum) {
			throw new Error(
				`Migration version ${row.version} (${row.name}) has changed since it was applied. ` +
					`Migrations are append-only: add a new one instead of editing a shipped one.`
			);
		}
	}
}

/** Migrations this database has not had applied yet, in order. */
export function pendingMigrations(
	db: Db,
	migrations: readonly Migration[] = MIGRATIONS
): Migration[] {
	const applied = appliedMigrations(db);
	assertUsable(migrations, applied);

	const done = new Set(applied.map((row) => row.version));
	return migrations.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
}

/**
 * Bring the database up to date and return what that took.
 *
 * Each migration runs inside a transaction, so a migration that fails part way
 * leaves nothing behind and the failure is visible on the next boot rather than
 * being half-applied.
 *
 * A migration marked `rebuildsTables` gets the one exception SQLite forces: the
 * foreign-key pragma is turned off around it, because a table rebuild has to
 * drop the old table and a drop with enforcement on cascades into everything
 * referencing it. The pragma cannot be toggled inside a transaction, so the
 * runner is the only place it can happen. `foreign_key_check` afterwards is what
 * makes that safe rather than merely quiet: a rebuild that left a dangling
 * reference fails here, before anything else runs.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
	const pending = pendingMigrations(db, migrations);

	const record = db.prepare(
		`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at)
		 VALUES (?, ?, ?, ?)`
	);

	for (const migration of pending) {
		const apply = db.transaction(() => {
			db.exec(migration.sql);
			record.run(migration.version, migration.name, checksum(migration.sql), Date.now());
		});

		if (!migration.rebuildsTables) {
			apply();
			continue;
		}

		db.pragma('foreign_keys = OFF');
		try {
			apply();

			const dangling = db.pragma('foreign_key_check') as unknown[];
			if (dangling.length > 0) {
				throw new Error(
					`migration ${migration.version} (${migration.name}) left ${dangling.length} ` +
						`dangling foreign key reference(s)`
				);
			}
		} finally {
			// Restored even when the rebuild threw: the connection outlives this
			// call, and one that quietly stopped enforcing references would be the
			// worst possible thing to leave behind.
			db.pragma('foreign_keys = ON');
		}
	}

	return pending;
}
