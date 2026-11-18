/**
 * Which agents a message names with `@name`.
 *
 * The owner: "mentioning an agent with @agent-name will notify them only;
 * otherwise all agents will be notified." A message with rows here reaches only
 * the agents named; one with none reaches everybody, exactly as before.
 *
 * A table rather than a column because names are not unique: `@build-bot`
 * names every agent called that, so one message can name several.
 *
 * Nothing is backfilled. Old messages were sent to everyone, and reading their
 * bodies now would quietly take them out of inboxes they were already in.
 */
export const sql = `
CREATE TABLE message_mentions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	message_id TEXT NOT NULL REFERENCES messages (id),
	agent_id TEXT NOT NULL REFERENCES agents (id)
) STRICT;

CREATE UNIQUE INDEX message_mentions_message_agent ON message_mentions (message_id, agent_id);
CREATE INDEX message_mentions_agent ON message_mentions (agent_id, message_id);
`;
