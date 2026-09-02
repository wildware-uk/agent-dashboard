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
	// `theme` is appended by migration 006: a logo and two colours (design §7).
	projects: [
		'slug',
		'name',
		'description',
		'status',
		'pinned',
		'created_at',
		'updated_at',
		'theme',
		// Appended by migration 009: how the owner wants their tasks laid out (§7).
		'board',
		// Appended by migration 011: when the owner last opened this project, which
		// is what the sidebar's "new" badge counts from.
		'owner_seen_at'
	],
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
		'deleted_at',
		// Appended by migration 004: an agent may correct its own card, and the
		// timeline says so rather than changing under the reader (design §3).
		'edited_at',
		// Appended by migration 007: how much the owner needs to care now, which is
		// a different axis from `level` (design §3, §7).
		'priority',
		// Appended by migration 008: the task this is progress on, if any (§3, §7).
		'task_id',
		// Appended by migration 015: when the owner last read the conversation on
		// this card, which is what lets it leave "Recent replies".
		'replies_seen_at'
	],
	media: [
		'agent_id',
		// Appended by migration 016: who posted it, in the vocabulary messages use,
		// and the message it hangs off. `agent_id` became nullable in the same
		// rebuild, so the owner can upload at all.
		'author',
		'update_id',
		'message_id',
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
		'result',
		// Appended by migration 010: when the owner sent this task out to the
		// project's agents, so unassigned work can notify without every unassigned
		// task notifying.
		'broadcast_at'
	],
	messages: [
		'project_id',
		'update_id',
		'task_id',
		'author',
		'body',
		'created_at',
		// Appended by migration 014: the post this answers, for the owner's own
		// feed cards, which anchor to nothing else.
		'reply_to',
		// Migration 017: soft delete, so every tab that rendered the line can be
		// told to drop it — the same shape `updates.deleted_at` keeps.
		'deleted_at',
		// Migration 020: the comment in the same thread this one answers, so a
		// thread carrying two conversations can still be read.
		'answers'
	],
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
		'answer',
		// Appended by migration 022: the thread the question was asked in, so an
		// agent that is already talking to its owner can ask where they are
		// reading rather than somewhere else.
		'message_id'
	],
	// Where a notification is delivered when the dashboard is not open (design §7).
	// A public link to one card, the only unauthenticated read in the product (§8).
	update_shares: ['update_id', 'token_hash', 'created_at', 'revoked_at', 'views', 'last_viewed_at'],
	push_subscriptions: [
		'endpoint',
		'p256dh',
		'auth',
		'label',
		'created_at',
		'last_sent_at',
		'failures',
		// Appended by migration 007: what this one device wants to hear about.
		'prefs'
	],
	// Migration 013: an agent saying "seen it" / "done" against one message or
	// one task, so a card the owner replied to is not silent.
	acknowledgements: ['agent_id', 'message_id', 'task_id', 'state', 'created_at', 'updated_at'],
	// Migration 021: what the owner is told about, kept so it can be read in the
	// app rather than only as a push nobody caught.
	notifications: [
		'kind',
		'project_id',
		'update_id',
		'message_id',
		'request_id',
		'agent_id',
		'title',
		'body',
		'created_at',
		'seen_at'
	],
	// Migration 018: the moment the server handed one message to one agent, so
	// "nobody has answered" can be told from "nobody was ever told".
	message_deliveries: [
		'message_id',
		'agent_id',
		'delivered_at',
		// Appended by migration 019: which connection was handed it. Two sessions
		// share one token here, so delivery had to stop being a fact about the
		// agent — one of them was consuming the only delivery there was.
		'client_id'
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
			media: [['sha256'], ['status', 'created_at'], ['update_id'], ['message_id']],
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
