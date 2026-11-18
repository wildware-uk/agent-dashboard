/**
 * Sound the dashboard can play.
 *
 * The owner: "allow agents and users to attach a number of sound files, that
 * can be played directly in the dashboard."
 *
 * ## What changes
 *
 * `media.kind` gains `audio`, beside `image`, `video` and `file`. It is a
 * `CHECK` constraint and SQLite cannot widen one in place, so this is a rebuild
 * — the same shape as migration 026, which added `file` for the same reason.
 *
 * ## Why audio is its own kind rather than a `file`
 *
 * A sound file could already be uploaded: anything the allowlist does not
 * render is stored as a `file` and handed back as a download. That is the whole
 * problem the owner is pointing at — a voice note you have to download, open in
 * something else and then find again is not "played directly in the dashboard".
 *
 * Being renderable means being **served inline from this origin**, which is the
 * decision that needs a kind of its own rather than a special case in the
 * player. It comes with the strict treatment every renderable type gets
 * (`src/media/mime.ts`): a short allowlist, and bytes sniffed against the type
 * they claim, so a script renamed `.mp3` never reaches an `<audio>` tag.
 *
 * Nothing is converted. Existing rows keep the kind they have, including any
 * sound somebody has already sent as a `file` — those are history, they still
 * download, and rewriting them would be this migration claiming to know what
 * bytes it has never read.
 */
export const sql = `
CREATE TABLE media_rebuilt (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT REFERENCES agents (id),
	author TEXT NOT NULL,
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
	mime TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	duration_ms INTEGER,
	filename TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
	created_at INTEGER NOT NULL,
	-- Migration 030: an approval and a task carry attachments too. Carried
	-- through this rebuild rather than reinvented; a column quietly dropped here
	-- would take every question's screenshots with it.
	request_id TEXT REFERENCES approvals (id),
	task_id TEXT REFERENCES tasks (id)
) STRICT;

INSERT INTO media_rebuilt
	(seq, id, agent_id, author, update_id, message_id, kind, mime, bytes, sha256,
	 width, height, duration_ms, filename, status, created_at, request_id, task_id)
SELECT seq, id, agent_id, author, update_id, message_id, kind, mime, bytes, sha256,
	 width, height, duration_ms, filename, status, created_at, request_id, task_id
FROM media;

DROP TABLE media;
ALTER TABLE media_rebuilt RENAME TO media;

-- Every index on the old table has to be recreated: one quietly missed is a
-- table scan nobody sees.
CREATE INDEX media_sha256 ON media (sha256);
CREATE INDEX media_status_created ON media (status, created_at);
CREATE INDEX media_update ON media (update_id);
CREATE INDEX media_message ON media (message_id);
`;
