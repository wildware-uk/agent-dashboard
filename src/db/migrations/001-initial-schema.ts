/**
 * The full data model from design §3.
 *
 * Conventions, applied to every table:
 *
 * - `seq INTEGER PRIMARY KEY AUTOINCREMENT` — the cursor and event-ordering key.
 *   `AUTOINCREMENT` (rather than a bare rowid alias) is deliberate: it never
 *   reuses a value after a delete, so a browser holding `seq = 41` can never be
 *   handed a different row 41 later.
 * - `id TEXT NOT NULL UNIQUE` — a ULID. Sortable and safe to expose.
 * - Timestamps are INTEGER milliseconds since the epoch. One representation
 *   everywhere means no parsing and no timezone questions in SQL.
 * - Booleans are INTEGER 0/1, constrained.
 * - `STRICT` tables, so a string written into an integer column is an error at
 *   the write rather than a surprise at the read.
 * - Enumerations are `CHECK` constraints, because the values in the design are
 *   closed sets and the database is the last place that can enforce them.
 */
export const sql = `
CREATE TABLE projects (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	slug TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX projects_status_pinned ON projects (status, pinned DESC, seq DESC);

CREATE TABLE agents (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER,
	last_seen_at INTEGER
) STRICT;

CREATE TABLE sessions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	started_at INTEGER NOT NULL,
	last_heartbeat_at INTEGER NOT NULL,
	ended_at INTEGER,
	meta TEXT
) STRICT;

-- Presence is derived from the newest heartbeat per agent (design §4).
CREATE INDEX sessions_agent_heartbeat ON sessions (agent_id, last_heartbeat_at DESC);
CREATE INDEX sessions_open_heartbeat ON sessions (last_heartbeat_at) WHERE ended_at IS NULL;

CREATE TABLE updates (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	project_id TEXT NOT NULL REFERENCES projects (id),
	agent_id TEXT NOT NULL REFERENCES agents (id),
	session_id TEXT REFERENCES sessions (id),
	title TEXT,
	body TEXT NOT NULL,
	level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warn', 'error')),
	pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
) STRICT;

-- The timeline: one project, newest first, paged by seq.
CREATE INDEX updates_project_seq ON updates (project_id, seq DESC);
CREATE INDEX updates_agent_seq ON updates (agent_id, seq DESC);
CREATE INDEX updates_live_seq ON updates (seq DESC) WHERE deleted_at IS NULL;

CREATE TABLE media (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	update_id TEXT REFERENCES updates (id),
	kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
	mime TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	duration_ms INTEGER,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
	created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX media_sha256 ON media (sha256);
-- The sweeper's query: ready media with no update, older than an hour (design §3).
CREATE INDEX media_status_created ON media (status, created_at);
CREATE INDEX media_update ON media (update_id);

CREATE TABLE derivatives (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('thumb', 'poster', 'mp4')),
	path TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	width INTEGER,
	height INTEGER
) STRICT;

-- One derivative of a given kind and size per media item: 'thumb' exists at two
-- widths (design §6), so width is part of the key.
-- coalesce, not a bare width: SQLite treats NULLs as distinct in a unique index,
-- so a poster frame with no recorded width could otherwise be stored twice.
CREATE UNIQUE INDEX derivatives_media_kind_width
	ON derivatives (media_id, kind, coalesce(width, -1));
CREATE INDEX derivatives_media_kind ON derivatives (media_id, kind);

CREATE TABLE upload_tokens (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
	max_bytes INTEGER NOT NULL,
	mime_allow TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
) STRICT;

CREATE INDEX upload_tokens_media ON upload_tokens (media_id);
CREATE INDEX upload_tokens_expires ON upload_tokens (expires_at) WHERE used_at IS NULL;

CREATE TABLE tasks (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	project_id TEXT NOT NULL REFERENCES projects (id),
	agent_id TEXT REFERENCES agents (id),
	title TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'claimed', 'done', 'cancelled')),
	created_at INTEGER NOT NULL,
	claimed_at INTEGER,
	done_at INTEGER,
	result TEXT
) STRICT;

CREATE INDEX tasks_project_state ON tasks (project_id, state, seq DESC);
CREATE INDEX tasks_agent_state ON tasks (agent_id, state) WHERE agent_id IS NOT NULL;

CREATE TABLE messages (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	project_id TEXT REFERENCES projects (id),
	update_id TEXT REFERENCES updates (id),
	task_id TEXT REFERENCES tasks (id),
	author TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX messages_project_seq ON messages (project_id, seq);
CREATE INDEX messages_update ON messages (update_id);
CREATE INDEX messages_task ON messages (task_id);

-- Unread state per reader, so a second reader is not a schema change (design §3).
CREATE TABLE read_cursors (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL UNIQUE REFERENCES agents (id),
	last_seen_message_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE approvals (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	project_id TEXT REFERENCES projects (id),
	update_id TEXT REFERENCES updates (id),
	question TEXT NOT NULL,
	options TEXT,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending', 'approved', 'rejected', 'timeout', 'cancelled')),
	expires_at INTEGER NOT NULL,
	decided_at INTEGER,
	decided_value TEXT
) STRICT;

-- The sweeper's query: pending approvals whose expires_at has passed (design §5).
CREATE INDEX approvals_state_expires ON approvals (state, expires_at);
CREATE INDEX approvals_agent_seq ON approvals (agent_id, seq DESC);
`;
