/**
 * A read cursor per project, not one per agent.
 *
 * The owner asked, for the third time, why a channel had gone quiet: "agent
 * channels aren't delivering again?" Every one of their sessions authenticates
 * with the same bearer token, so the server sees one agent with several live
 * connections — and unread was one integer for that agent. A session catching
 * up in its own project dragged the single cursor past another project's
 * unread, and the stream computes what to announce from exactly that number, so
 * the message that had been stepped over could never be announced again. The
 * owner saw a message they had written sitting on the dashboard, never
 * delivered, with no way to make it happen a second time.
 *
 * `readTo` was the previous attempt at this: hold the cursor short of anything
 * a narrowed read stepped over. It cannot be made to work, because the thing
 * being protected is shared — one number cannot be behind for melon-merge and
 * ahead for this project at once. A row per project can.
 *
 * The old value is copied to every project, which is the honest reading of what
 * it meant: "this agent has seen everything up to here, wherever it was."
 * Messages that belong to no project get the `''` bucket, so there is always a
 * row to compare against and `UNIQUE (agent_id, project_id)` stays usable as an
 * upsert target — a nullable column would not, since SQLite treats NULLs as
 * distinct.
 *
 * The seeded ids are random hex rather than the ULIDs the application mints:
 * this file is SQL, ids here are only required to be unique, and nothing reads
 * a cursor by id.
 */
export const sql = `
ALTER TABLE read_cursors RENAME TO read_cursors_old;

CREATE TABLE read_cursors (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	project_id TEXT NOT NULL DEFAULT '',
	last_seen_message_seq INTEGER NOT NULL DEFAULT 0,
	UNIQUE (agent_id, project_id)
) STRICT;

INSERT INTO read_cursors (id, agent_id, project_id, last_seen_message_seq)
SELECT lower(hex(randomblob(13))), old.agent_id, projects.id, old.last_seen_message_seq
  FROM read_cursors_old AS old, projects;

INSERT INTO read_cursors (id, agent_id, project_id, last_seen_message_seq)
SELECT lower(hex(randomblob(13))), old.agent_id, '', old.last_seen_message_seq
  FROM read_cursors_old AS old;

DROP TABLE read_cursors_old;

CREATE INDEX read_cursors_agent ON read_cursors (agent_id, project_id);
`;
