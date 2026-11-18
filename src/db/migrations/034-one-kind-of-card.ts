/**
 * Every card type carrying the same features.
 *
 * The owner: "let me pin my own messages, there are many discrepancies between
 * the card types, they should all share the same features, and be implemented in
 * a generic modular fashion, we need to do a refactor."
 *
 * They are right, and the discrepancies were accidents of order rather than
 * decisions. Each feature was built for whichever card needed it first and
 * stopped there:
 *
 * | feature   | update | post | question | task |
 * |-----------|--------|------|----------|------|
 * | media     | 030    | 016  | 030      | 030  |
 * | embeds    | 027    | 027  | 030      | 030  |
 * | thread    | 001    | 014  | 032      | 001  |
 * | edited    | 006    | 033  | 033      | —    |
 * | pinned    | 001    | —    | —        | —    |
 * | reactions | —      | 024  | —        | —    |
 * | acks      | —      | 013  | —        | 013  |
 *
 * This migration fills the empty cells. The three that were one card's alone —
 * pinning, reactions, acknowledgements — become things any card can carry, and a
 * task gains the `edited_at` its words always needed.
 *
 * ## The shape: one nullable column per card kind
 *
 * Not a polymorphic `(target_kind, target_id)` pair, which is the obvious
 * generic answer and the wrong one here: SQLite cannot put a foreign key on it,
 * so nothing would stop a reaction pointing at a card that never existed or
 * outliving one that was deleted. The columns are how `media`, `embeds`,
 * `acknowledgements` and `messages` already name their card (migrations 030,
 * 032), so this is the existing pattern finished rather than a second one
 * invented beside it. `$db` reads them through one list of anchors and `$domain`
 * dispatches on a single `CardRef`, which is where the modularity lives.
 *
 * ## Why `reactions` is a rebuild and nothing else is
 *
 * `reactions.message_id` is `NOT NULL`, and SQLite cannot relax that in place —
 * the same wall migrations 026 and 031 met. Everything else here is an
 * `ADD COLUMN` whose default is the truth for every existing row: nothing has
 * been pinned that was not already, and nothing has been edited.
 *
 * The rebuilt table keeps one *partial* unique index per anchor rather than one
 * index across all four, because `NULL` is not equal to itself in SQLite: a
 * single index over the four columns would let the same reactor put the same
 * emoji on the same card any number of times, which is exactly the double count
 * migration 024 wrote its index to prevent.
 */
export const sql = `
-- Pinning: the owner's, on anything they want kept at the top of the feed.
ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- A task's words can be corrected, as every other card's can (migration 033).
ALTER TABLE tasks ADD COLUMN edited_at INTEGER;

-- Acknowledgements on a card and on a question, not only on a message and a
-- task: "I have seen this" is worth saying about anything an owner posts.
ALTER TABLE acknowledgements ADD COLUMN update_id TEXT REFERENCES updates (id);
ALTER TABLE acknowledgements ADD COLUMN request_id TEXT REFERENCES approvals (id);

-- One live acknowledgement per agent per thing, the same partial shape
-- migration 013 gave the first two anchors.
CREATE UNIQUE INDEX acknowledgements_agent_update ON acknowledgements (agent_id, update_id)
	WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX acknowledgements_agent_request ON acknowledgements (agent_id, request_id)
	WHERE request_id IS NOT NULL;

CREATE INDEX acknowledgements_update ON acknowledgements (update_id);
CREATE INDEX acknowledgements_request ON acknowledgements (request_id);

-- Reactions on any card.
CREATE TABLE reactions_rebuilt (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	message_id TEXT REFERENCES messages (id),
	update_id TEXT REFERENCES updates (id),
	request_id TEXT REFERENCES approvals (id),
	task_id TEXT REFERENCES tasks (id),
	actor TEXT NOT NULL,
	emoji TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

INSERT INTO reactions_rebuilt (seq, id, message_id, actor, emoji, created_at)
SELECT seq, id, message_id, actor, emoji, created_at FROM reactions;

DROP TABLE reactions;
ALTER TABLE reactions_rebuilt RENAME TO reactions;

-- One of each per reactor per card, per anchor: partial, because NULL is not
-- equal to itself and one index across the four would enforce nothing.
CREATE UNIQUE INDEX reactions_message_actor_emoji ON reactions (message_id, actor, emoji)
	WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX reactions_update_actor_emoji ON reactions (update_id, actor, emoji)
	WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX reactions_request_actor_emoji ON reactions (request_id, actor, emoji)
	WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX reactions_task_actor_emoji ON reactions (task_id, actor, emoji)
	WHERE task_id IS NOT NULL;

-- The read a card makes: every reaction on the things it is rendering.
CREATE INDEX reactions_message ON reactions (message_id);
CREATE INDEX reactions_update ON reactions (update_id);
CREATE INDEX reactions_request ON reactions (request_id);
CREATE INDEX reactions_task ON reactions (task_id);
`;
