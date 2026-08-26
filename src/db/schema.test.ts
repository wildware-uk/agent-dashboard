import { describe, expect, it } from 'vitest';
import { freshDatabase } from './testing';
import { TABLES } from './schema';

const db = freshDatabase();

type ColumnInfo = { name: string; type: string; notnull: number; pk: number };
type IndexInfo = { name: string; unique: number };

const columns = (table: string) =>
	db
		.prepare<[string], ColumnInfo>(`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`)
		.all(table);

const columnNames = (table: string) => columns(table).map((c) => c.name);

const indexes = (table: string) =>
	db.prepare<[string], IndexInfo>(`SELECT name, "unique" FROM pragma_index_list(?)`).all(table);

const indexColumns = (index: string) =>
	db
		.prepare<[string], { name: string }>(`SELECT name FROM pragma_index_info(?)`)
		.all(index)
		.map((c) => c.name);

/** The columns the design's §3 table gives each entity, beyond `id` and `seq`. */
const DESIGN_COLUMNS: Record<string, string[]> = {
	projects: ['slug', 'name', 'description', 'status', 'pinned', 'created_at', 'updated_at'],
	agents: ['name', 'token_hash', 'created_at', 'revoked_at', 'last_seen_at'],
	sessions: ['agent_id', 'started_at', 'last_heartbeat_at', 'ended_at', 'meta'],
	updates: [
		'project_id',
		'agent_id',
		'session_id',
		'title',
		'body',
		'level',
		'pinned',
		'created_at',
		'deleted_at'
	],
	media: [
		'agent_id',
		'update_id',
		'kind',
		'mime',
		'bytes',
		'sha256',
		'width',
		'height',
		'duration_ms',
		'status',
		'created_at'
	],
	derivatives: ['media_id', 'kind', 'path', 'bytes', 'width', 'height'],
	upload_tokens: ['agent_id', 'media_id', 'max_bytes', 'mime_allow', 'expires_at', 'used_at'],
	tasks: [
		'project_id',
		'agent_id',
		'title',
		'body',
		'state',
		'created_at',
		'claimed_at',
		'done_at',
		'result'
	],
	messages: ['project_id', 'update_id', 'task_id', 'author', 'body', 'created_at'],
	read_cursors: ['agent_id', 'last_seen_message_seq'],
	// The four columns migration 002 appends carry the other four request kinds
	// (design §5). They are listed after the 001 columns because `ALTER TABLE ADD
	// COLUMN` appends, and appending is exactly what keeps 001 unedited.
	approvals: [
		'agent_id',
		'project_id',
		'update_id',
		'question',
		'options',
		'state',
		'expires_at',
		'decided_at',
		'decided_value',
		'kind',
		'detail',
		'config',
		'answer'
	]
};

describe('schema', () => {
	it('has exactly the tables the design lists', () => {
		const present = db
			.prepare<[], { name: string }>(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
				 ORDER BY name`
			)
			.all()
			.map((r) => r.name);

		expect(present).toEqual([...TABLES].sort());
		expect([...TABLES].sort()).toEqual(Object.keys(DESIGN_COLUMNS).sort());
	});

	it.each(TABLES)('%s carries every column the design gives it', (table) => {
		expect(columnNames(table)).toEqual(['seq', 'id', ...DESIGN_COLUMNS[table]]);
	});

	it.each(TABLES)('%s has a text ULID id that is unique and not null', (table) => {
		const id = columns(table).find((c) => c.name === 'id');

		expect(id).toMatchObject({ type: 'TEXT', notnull: 1 });

		const unique = indexes(table).some(
			(index) => index.unique === 1 && indexColumns(index.name).join() === 'id'
		);
		expect(unique, `${table}.id needs a unique index`).toBe(true);
	});

	it.each(TABLES)('%s has an autoincrementing integer seq', (table) => {
		expect(columns(table).find((c) => c.name === 'seq')).toMatchObject({
			type: 'INTEGER',
			pk: 1
		});

		const sql = db
			.prepare<[string], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`)
			.get(table)!.sql;
		expect(sql).toMatch(/seq INTEGER PRIMARY KEY AUTOINCREMENT/);
	});

	it('never reuses a seq after a delete, so cursors stay monotonic', () => {
		const fresh = freshDatabase();
		fresh
			.prepare(
				`INSERT INTO projects (id, slug, name, status, pinned, created_at, updated_at)
				 VALUES ('p1', 'a', 'A', 'active', 0, 1, 1)`
			)
			.run();
		fresh.prepare(`DELETE FROM projects`).run();
		fresh
			.prepare(
				`INSERT INTO projects (id, slug, name, status, pinned, created_at, updated_at)
				 VALUES ('p2', 'b', 'B', 'active', 0, 1, 1)`
			)
			.run();

		expect(fresh.prepare<[], { seq: number }>(`SELECT seq FROM projects`).get()!.seq).toBe(2);
	});

	it('enforces the enumerations from the design', () => {
		const fresh = freshDatabase();
		fresh
			.prepare(
				`INSERT INTO projects (id, slug, name, status, pinned, created_at, updated_at)
				 VALUES ('p1', 'a', 'A', 'active', 0, 1, 1)`
			)
			.run();
		fresh
			.prepare(`INSERT INTO agents (id, name, token_hash, created_at) VALUES ('a1', 'A', 'h', 1)`)
			.run();

		const insert = (level: string) =>
			fresh
				.prepare(
					`INSERT INTO updates (id, project_id, agent_id, body, level, pinned, created_at)
					 VALUES (?, 'p1', 'a1', 'x', ?, 0, 1)`
				)
				.run(`u-${level}`, level);

		expect(() => insert('info')).not.toThrow();
		expect(() => insert('shouting')).toThrow(/CHECK/);
	});

	it('indexes every lookup and cursor path the design needs', () => {
		const expected: Record<string, string[][]> = {
			projects: [['slug']],
			agents: [['token_hash']],
			sessions: [['agent_id', 'last_heartbeat_at']],
			updates: [['project_id', 'seq']],
			media: [['sha256'], ['status', 'created_at'], ['update_id']],
			derivatives: [['media_id', 'kind']],
			upload_tokens: [['media_id']],
			tasks: [['project_id', 'state']],
			messages: [['project_id', 'seq']],
			read_cursors: [['agent_id']],
			approvals: [['state', 'expires_at']]
		};

		for (const [table, wanted] of Object.entries(expected)) {
			const present = indexes(table).map((index) => indexColumns(index.name));
			for (const cols of wanted) {
				// A leading-column prefix is enough: an index on (a, b, c) serves a
				// lookup on (a, b).
				const served = present.some((columns) => cols.every((column, i) => columns[i] === column));
				expect(served, `${table} needs an index on (${cols.join(', ')})`).toBe(true);
			}
		}
	});

	it('enables foreign keys, so an orphan row cannot be written', () => {
		const fresh = freshDatabase();

		expect(() =>
			fresh
				.prepare(
					`INSERT INTO sessions (id, agent_id, started_at, last_heartbeat_at)
					 VALUES ('s1', 'nobody', 1, 1)`
				)
				.run()
		).toThrow(/FOREIGN KEY/);
	});
});
