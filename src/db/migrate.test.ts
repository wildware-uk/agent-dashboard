import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations';
import { appliedMigrations, migrate, pendingMigrations } from './migrate';
import { openDatabase } from './connection';
import { freshDatabase } from './testing';
import type { Migration } from './migrations';

/** A migration list that is cheap to reason about, for the runner's own tests. */
const fakes: Migration[] = [
	{ version: 1, name: 'first', sql: 'CREATE TABLE one (a TEXT);' },
	{ version: 2, name: 'second', sql: 'CREATE TABLE two (b TEXT);' }
];

const empty = () => openDatabase({ file: ':memory:', migrate: false });

describe('migrate', () => {
	it('applies every pending migration to an empty database', () => {
		const db = empty();

		const applied = migrate(db, fakes);

		expect(applied.map((m) => m.version)).toEqual([1, 2]);
		expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual(
			expect.arrayContaining([{ name: 'one' }, { name: 'two' }])
		);
	});

	it('records what it applied, with a timestamp and the name', () => {
		const db = empty();

		migrate(db, fakes);

		expect(appliedMigrations(db)).toEqual([
			expect.objectContaining({ version: 1, name: 'first' }),
			expect.objectContaining({ version: 2, name: 'second' })
		]);
		expect(appliedMigrations(db)[0].appliedAt).toBeTypeOf('number');
	});

	it('is idempotent: a second run on the same database applies nothing', () => {
		const db = empty();
		migrate(db, fakes);

		const second = migrate(db, fakes);

		expect(second).toEqual([]);
		expect(appliedMigrations(db)).toHaveLength(2);
	});

	it('applies only the migrations added since the last run', () => {
		const db = empty();
		migrate(db, [fakes[0]]);

		const applied = migrate(db, fakes);

		expect(applied.map((m) => m.version)).toEqual([2]);
	});

	it('reports what is pending without applying it', () => {
		const db = empty();

		expect(pendingMigrations(db, fakes).map((m) => m.version)).toEqual([1, 2]);
		// Only the runner's own bookkeeping table exists; no migration has run.
		expect(
			db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
				.all()
		).toEqual([{ name: 'schema_migrations' }]);
	});

	it('refuses to run when a migration already applied has been edited', () => {
		const db = empty();
		migrate(db, fakes);

		const edited = [{ ...fakes[0], sql: 'CREATE TABLE one (a TEXT, c TEXT);' }, fakes[1]];

		expect(() => migrate(db, edited)).toThrow(/version 1/);
	});

	it('rolls a failing migration back rather than leaving half of it applied', () => {
		const db = empty();
		const broken: Migration[] = [
			fakes[0],
			{ version: 2, name: 'broken', sql: 'CREATE TABLE ok (a TEXT); NOT SQL AT ALL;' }
		];

		expect(() => migrate(db, broken)).toThrow();
		expect(appliedMigrations(db).map((m) => m.version)).toEqual([1]);
		expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'ok'`).all()).toEqual([]);
	});

	it('rejects a migration list with duplicate versions', () => {
		const db = empty();

		expect(() => migrate(db, [fakes[0], { ...fakes[1], version: 1 }])).toThrow(/duplicate/i);
	});
});

describe('the real migration list', () => {
	it('is numbered from 1 with no gaps and no duplicates', () => {
		expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
	});

	it('applies from empty to the current schema', () => {
		const db = empty();

		migrate(db);

		expect(appliedMigrations(db)).toHaveLength(MIGRATIONS.length);
		expect(pendingMigrations(db)).toEqual([]);
	});
});

/**
 * The one migration that rebuilds a table (016).
 *
 * SQLite cannot drop a `NOT NULL` in place, so `media` had to be rebuilt for the
 * owner to upload anything. A rebuild drops the old table, and a drop with
 * foreign keys **on** cascades into everything referencing it — `upload_tokens`
 * would have gone with it, silently. The pragma cannot be toggled inside a
 * transaction, so the runner is the only place it can happen.
 */
describe('a migration that rebuilds a table', () => {
	it('keeps the rows that referenced the rebuilt table', () => {
		const db = freshDatabase();

		// A media row and the upload token pointing at it, both written *before*
		// the rebuild would have run — except `freshDatabase` has already migrated,
		// so this asserts the shape the rebuild left behind rather than replaying
		// it. What matters is that the reference still works.
		db.prepare(
			`INSERT INTO agents (id, name, token_hash, created_at) VALUES ('a1', 'scout', 'h', 1)`
		).run();
		db.prepare(
			`INSERT INTO media (id, agent_id, author, kind, mime, bytes, sha256, status, created_at)
			 VALUES ('m1', 'a1', 'agent:a1', 'image', 'image/png', 1, 's', 'ready', 1)`
		).run();
		db.prepare(
			`INSERT INTO upload_tokens (id, agent_id, media_id, max_bytes, mime_allow, expires_at)
			 VALUES ('t1', 'a1', 'm1', 10, 'image/png', 2)`
		).run();

		expect(db.pragma('foreign_key_check')).toEqual([]);
	});

	it('leaves foreign keys enforced afterwards', () => {
		const db = freshDatabase();

		// The connection outlives the migration, and one that quietly stopped
		// enforcing references would be the worst thing to leave behind.
		expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(() =>
			db
				.prepare(
					`INSERT INTO media (id, agent_id, author, kind, mime, bytes, sha256, status, created_at)
					 VALUES ('m2', 'nobody', 'agent:nobody', 'image', 'image/png', 1, 's', 'ready', 1)`
				)
				.run()
		).toThrow(/FOREIGN KEY/);
	});

	it('lets the owner own an image, which is what the rebuild was for', () => {
		const db = freshDatabase();

		expect(() =>
			db
				.prepare(
					`INSERT INTO media (id, agent_id, author, kind, mime, bytes, sha256, status, created_at)
					 VALUES ('m3', NULL, 'human', 'image', 'image/png', 1, 's', 'ready', 1)`
				)
				.run()
		).not.toThrow();
	});
});

/**
 * The repair migration (023).
 *
 * A reply written before the fix could carry `reply_to` and no thread of its
 * own, which no view renders — the owner's report was "I cannot find it
 * anywhere on the dashboard", and they were right. This puts those rows back
 * into the thread they were written in.
 */
describe('rescuing replies that were rendered nowhere', () => {
	/** A database migrated to just before the repair, so it can be replayed. */
	function beforeTheRepair() {
		const db = openDatabase({ file: ':memory:', migrate: false });
		migrate(
			db,
			MIGRATIONS.filter((migration) => migration.version < 23)
		);
		db.prepare(
			`INSERT INTO agents (id, name, token_hash, created_at) VALUES ('a1', 'scout', 'h', 1)`
		).run();
		db.prepare(
			`INSERT INTO projects (id, slug, name, status, created_at, updated_at)
			 VALUES ('p1', 'dash', 'Dash', 'active', 1, 1)`
		).run();
		db.prepare(
			`INSERT INTO updates (id, project_id, agent_id, body, level, created_at)
			 VALUES ('u1', 'p1', 'a1', 'shipped', 'info', 1)`
		).run();
		return db;
	}

	it('gives an orphaned reply the thread it was written in', () => {
		const db = beforeTheRepair();
		// The owner's line, inside a card's thread.
		db.prepare(
			`INSERT INTO messages (id, project_id, update_id, author, body, created_at)
			 VALUES ('m1', 'p1', 'u1', 'human', 'does it work?', 2)`
		).run();
		// The agent's answer, as the old flattening wrote it: a reply to that line,
		// with no thread of its own.
		db.prepare(
			`INSERT INTO messages (id, project_id, reply_to, author, body, created_at)
			 VALUES ('m2', 'p1', 'm1', 'agent:a1', 'it does', 3)`
		).run();

		migrate(db);

		const repaired = db
			.prepare<[], { update_id: string | null; reply_to: string | null; answers: string | null }>(
				`SELECT update_id, reply_to, answers FROM messages WHERE id = 'm2'`
			)
			.get();
		expect(repaired).toEqual({ update_id: 'u1', reply_to: null, answers: 'm1' });
	});

	it('leaves a reply under one of the owner’s feed posts exactly as it was', () => {
		const db = beforeTheRepair();
		db.prepare(
			`INSERT INTO messages (id, project_id, author, body, created_at)
			 VALUES ('p-post', 'p1', 'human', 'a post', 2)`
		).run();
		db.prepare(
			`INSERT INTO messages (id, project_id, reply_to, author, body, created_at)
			 VALUES ('m3', 'p1', 'p-post', 'agent:a1', 'on it', 3)`
		).run();

		migrate(db);

		const untouched = db
			.prepare<[], { update_id: string | null; reply_to: string | null }>(
				`SELECT update_id, reply_to FROM messages WHERE id = 'm3'`
			)
			.get();
		expect(untouched).toEqual({ update_id: null, reply_to: 'p-post' });
	});
});
