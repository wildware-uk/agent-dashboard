/**
 * An agent taking back a question nobody needs answered any more.
 *
 * The owner: "let an agent dismiss its own question (eg its no longer
 * relevant)."
 *
 * Until now a request could end in four ways and an agent could cause none of
 * them: the owner answers it, the owner dismisses it, or the sweeper times it
 * out. So an agent that asked "shall I retry the deploy?" and then found the
 * deploy had succeeded had no way to say so — its question sat on the owner's
 * banner until somebody dealt with a decision that no longer existed.
 *
 * ## Why this is a fifth state rather than a reuse of `cancelled`
 *
 * `cancelled` means *the owner declined to answer*, and the agent is told as
 * much in those words — the channel says "your owner dismissed your request
 * without answering. That is not permission." Reusing it for a withdrawal would
 * make the dashboard tell an agent that the owner had refused something the
 * agent itself took back, which is a lie about the one person who did nothing.
 *
 * The two also read differently in history, which is the part that lasts: a
 * dismissed request is a question the owner chose not to answer, and a withdrawn
 * one is a question that stopped mattering. Those are worth being able to tell
 * apart a week later.
 *
 * ## Why this is a rebuild
 *
 * `state` carries a `CHECK`, and SQLite cannot widen one in place — the same
 * reason migrations 016 and 026 rebuilt `media`. The table is copied with its
 * columns exactly as they stand today, including the five that later migrations
 * appended (`kind`, `detail`, `config`, `answer`, `message_id`), and every index
 * is recreated: one quietly missed is a table scan on the sweeper's hot path
 * that nobody would see until the dashboard felt slow.
 */
export const sql = `
CREATE TABLE approvals_rebuilt (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	project_id TEXT REFERENCES projects (id),
	update_id TEXT REFERENCES updates (id),
	question TEXT NOT NULL,
	options TEXT,
	-- 'withdrawn' is the new one: the asking agent took the question back.
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending', 'approved', 'rejected', 'timeout', 'cancelled', 'withdrawn')),
	expires_at INTEGER NOT NULL,
	decided_at INTEGER,
	decided_value TEXT,
	kind TEXT NOT NULL DEFAULT 'confirm',
	detail TEXT,
	config TEXT,
	answer TEXT,
	message_id TEXT REFERENCES messages (id)
) STRICT;

INSERT INTO approvals_rebuilt
	(seq, id, agent_id, project_id, update_id, question, options, state, expires_at,
	 decided_at, decided_value, kind, detail, config, answer, message_id)
SELECT seq, id, agent_id, project_id, update_id, question, options, state, expires_at,
	 decided_at, decided_value, kind, detail, config, answer, message_id
FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_rebuilt RENAME TO approvals;

-- The sweeper's query: pending approvals whose expires_at has passed (design §5).
CREATE INDEX approvals_state_expires ON approvals (state, expires_at);
CREATE INDEX approvals_agent_seq ON approvals (agent_id, seq DESC);
-- What one agent has outstanding, which the stream counts on every event.
CREATE INDEX approvals_agent_state ON approvals (agent_id, state);
-- A question asked inside a thread, read whenever that thread renders.
CREATE INDEX approvals_message ON approvals (message_id);
`;
