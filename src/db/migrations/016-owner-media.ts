/**
 * Images the owner uploaded, and images attached to a message.
 *
 * Two changes that need the same rebuild, so they happen together.
 *
 * ## Why this is a rebuild, when nothing else here is
 *
 * `media.agent_id` is `NOT NULL REFERENCES agents (id)`, and that was a real
 * decision rather than an accident: every image on this dashboard was posted by
 * an agent, so attribution was a fact about the row rather than a claim on it.
 * The owner asking to upload their own images ends that, and SQLite cannot drop
 * a `NOT NULL` in place.
 *
 * Migration 002 declined a rebuild in almost these words — "trading a real risk
 * for a theoretical one" — and it was right to: it wanted a `CHECK` the domain
 * already enforced. This one buys a feature that has no other shape. The
 * difference is worth stating, because the next person reading 002 should not
 * conclude that this file ignored it.
 *
 * The runner turns foreign keys off around this migration (`rebuildsTables`),
 * because dropping `media` with enforcement on would cascade into
 * `upload_tokens`, and `PRAGMA foreign_keys` is a no-op inside a transaction.
 * It runs `foreign_key_check` afterwards, so a rebuild that left anything
 * dangling fails rather than passing quietly.
 *
 * ## What changes
 *
 * - **`agent_id` becomes nullable**, and `author` carries who posted it in the
 *   vocabulary messages already use: `human`, or `agent:<agent_id>`. Two columns
 *   rather than one because `agent_id` is what every existing query joins on and
 *   what the upload token checks; `author` is what a card renders.
 * - **`message_id`**, so an image can hang off a reply or one of the owner's own
 *   posts. `update_id` stays exactly as it is: a card's images are still a
 *   card's images.
 *
 * Existing rows keep their `agent_id` and get `author` derived from it, so
 * nothing that was attributed to an agent stops being.
 */
export const sql = `
CREATE TABLE media_rebuilt (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT REFERENCES agents (id),
	author TEXT NOT NULL,
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
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

INSERT INTO media_rebuilt
	(seq, id, agent_id, author, update_id, message_id, kind, mime, bytes, sha256,
	 width, height, duration_ms, status, created_at)
SELECT seq, id, agent_id, 'agent:' || agent_id, update_id, NULL, kind, mime, bytes, sha256,
	 width, height, duration_ms, status, created_at
FROM media;

DROP TABLE media;
ALTER TABLE media_rebuilt RENAME TO media;

CREATE INDEX media_sha256 ON media (sha256);
-- The sweeper's query: ready media attached to nothing, older than an hour.
CREATE INDEX media_status_created ON media (status, created_at);
-- A card's images, as it renders. Rebuilt with the rest: every index on the old
-- table has to be recreated, and one quietly missed is a table scan nobody sees.
CREATE INDEX media_update ON media (update_id);
-- A message's images, read whenever a thread renders.
CREATE INDEX media_message ON media (message_id);
`;
