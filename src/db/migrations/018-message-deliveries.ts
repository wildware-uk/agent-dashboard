/**
 * When a message actually reached an agent.
 *
 * The dashboard could say a message was unread and it could say an agent had
 * acknowledged it, and there was nothing in between — so a message sitting
 * unanswered looked the same whether the agent had it and was busy, or was
 * never told at all. That gap is what this closes: the server records the
 * moment it pushed the message onto an agent's live stream, and the owner sees
 * "delivered to scout" under their own words within a second of it happening.
 *
 * **Per agent, not per message.** Several agents work in one project and each
 * of them is told separately, so "delivered" is a fact about a pair. A column
 * on `messages` would collapse that into whichever agent happened to be
 * connected first.
 *
 * It also makes the stream's don't-repeat rule durable. Announcing once was
 * remembered per connection, which is right until the process restarts or the
 * connection drops — and then the whole unread pile is announced again. A row
 * survives both.
 *
 * `delivered_at` is not `read`: only `get_messages` moves a read cursor, and an
 * agent that was handed a message and never looked at it is exactly the state
 * worth being able to see.
 */
export const sql = `
CREATE TABLE message_deliveries (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	message_id TEXT NOT NULL REFERENCES messages (id),
	agent_id TEXT NOT NULL REFERENCES agents (id),
	delivered_at INTEGER NOT NULL
) STRICT;

-- One delivery per agent per message: the second push of the same message is
-- the same fact, so it conflicts rather than accumulating.
CREATE UNIQUE INDEX message_deliveries_message_agent
	ON message_deliveries (message_id, agent_id);

-- The read the dashboard makes: every delivery on the messages it is about to
-- render.
CREATE INDEX message_deliveries_message ON message_deliveries (message_id);
-- And the read the stream makes: what this agent has already been sent.
CREATE INDEX message_deliveries_agent ON message_deliveries (agent_id, message_id);
`;
