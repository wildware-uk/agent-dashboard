/**
 * Emoji reactions on messages.
 *
 * The owner: "allow users and agents to react to messages, with emojis. These
 * can signal looking at, done, agree, disagree, emotions etc, its a nice simple
 * way to allow quick communication."
 *
 * The shape is the same one acknowledgements have (migration 013) with the
 * vocabulary opened up: one row per (message, who, which emoji), so somebody
 * reacting twice with the same emoji is the same fact rather than two, and the
 * card counts rows.
 *
 * **`actor` is a string, not a foreign key**, exactly as `messages.author` is
 * (design §3): the literal `human` for the owner, or `agent:<agent_id>`. The
 * owner is not a row in a single-owner deployment, and a nullable `agent_id`
 * plus a flag would be two columns encoding one fact.
 *
 * The emoji is stored as the text the reactor sent, not as an id into a table
 * of allowed ones. A closed list would be a list somebody has to maintain, and
 * the point of the feature is that it is quick.
 */
export const sql = `
CREATE TABLE reactions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	message_id TEXT NOT NULL REFERENCES messages (id),
	actor TEXT NOT NULL,
	emoji TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

-- One of each per reactor per message: reacting twice with the same emoji is
-- the same reaction, and a second row would double a count somebody reads.
CREATE UNIQUE INDEX reactions_message_actor_emoji ON reactions (message_id, actor, emoji);
-- The read a thread makes: every reaction on the messages it is rendering.
CREATE INDEX reactions_message ON reactions (message_id);
`;
