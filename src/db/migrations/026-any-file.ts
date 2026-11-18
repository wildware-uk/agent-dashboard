/**
 * Any file, not just pictures.
 *
 * The owner: "allow any files to be uploaded and sent to the agents, not just
 * images."
 *
 * ## What changes
 *
 * - **`kind` gains `file`.** A third kind beside `image` and `video`, for a PDF,
 *   a CSV, a log, a zip — anything the dashboard stores and hands over rather
 *   than renders. It is a `CHECK` constraint, and SQLite cannot widen one in
 *   place, so this is a rebuild for the same reason migration 016 was.
 * - **`filename` becomes a column**, and only for `file` rows.
 *
 * ## Why a filename is stored now, when it deliberately was not before
 *
 * `src/media/paths.ts` says a filename is "attacker-controlled text and has no
 * business anywhere near a path", and that stays true: the file on disk is still
 * `original.<extension from the type>` under a ULID this server minted, and
 * nothing here reaches a path. What changed is that there is now something a
 * name is *for*. An image is its own label — the owner sees the picture — but a
 * download called `01M1P….bin` tells nobody what it is, and an agent handed a
 * file with no name cannot say which of three it is reading.
 *
 * So the name is stored as **data, displayed as text, and never resolved**: it
 * names nothing on this filesystem, and the download route percent-encodes it
 * into `Content-Disposition` rather than concatenating it.
 *
 * `NULL` for every existing row and for every image and video, because for those
 * a filename was genuinely never kept and inventing one now would be a lie about
 * what the agent sent.
 */
export const sql = `
CREATE TABLE media_rebuilt (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT REFERENCES agents (id),
	author TEXT NOT NULL,
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'file')),
	mime TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	duration_ms INTEGER,
	-- What the uploader called it, for a file. Text on a card and a download
	-- name; never a path, and never looked up by.
	filename TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
	created_at INTEGER NOT NULL
) STRICT;

INSERT INTO media_rebuilt
	(seq, id, agent_id, author, update_id, message_id, kind, mime, bytes, sha256,
	 width, height, duration_ms, filename, status, created_at)
SELECT seq, id, agent_id, author, update_id, message_id, kind, mime, bytes, sha256,
	 width, height, duration_ms, NULL, status, created_at
FROM media;

DROP TABLE media;
ALTER TABLE media_rebuilt RENAME TO media;

CREATE INDEX media_sha256 ON media (sha256);
-- The sweeper's query: ready media attached to nothing, older than an hour.
CREATE INDEX media_status_created ON media (status, created_at);
-- A card's attachments, as it renders. Every index on the old table has to be
-- recreated: one quietly missed is a table scan nobody sees.
CREATE INDEX media_update ON media (update_id);
-- A message's attachments, read whenever a thread renders.
CREATE INDEX media_message ON media (message_id);
`;
