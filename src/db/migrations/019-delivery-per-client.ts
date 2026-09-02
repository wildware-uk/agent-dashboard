/**
 * Delivery is per *connection*, not per agent.
 *
 * Migration 018 recorded "this message reached this agent" and the stream used
 * that to stop repeating itself. That was wrong the moment two sessions shared
 * one token, which is the ordinary case here: they are one agent, so the first
 * connection handed a message consumed the only delivery there was and every
 * other session went hungry. With a dead session's bridge still holding a
 * socket open, the message was marked delivered and reached nobody.
 *
 * So the row gains the client that was handed it. Two live sessions are two
 * deliveries; one session reconnecting is still one, because a bridge keeps its
 * id for the life of the process — which is what makes a deploy stop
 * re-announcing the whole unread pile.
 *
 * `client_id` is nullable, for a connection that names none: an older bridge
 * that has not been restarted since this shipped. Those fall back to
 * remembering within the connection, which is where this started — they never
 * starve anybody, and they repeat only when they themselves reconnect.
 *
 * SQLite treats NULLs as distinct in a unique index, so anonymous rows never
 * collide with each other. The dashboard therefore reads deliveries per agent
 * rather than per row: what the owner wants to know is that it reached scout,
 * not how many sockets scout had open.
 */
export const sql = `
ALTER TABLE message_deliveries ADD COLUMN client_id TEXT;

DROP INDEX message_deliveries_message_agent;
-- One delivery per message per client. Rows with no client are per connection
-- and are deliberately allowed to repeat: NULL never equals NULL here.
CREATE UNIQUE INDEX message_deliveries_message_agent_client
	ON message_deliveries (message_id, agent_id, client_id);

DROP INDEX message_deliveries_agent;
-- The read the stream makes: what this client has already been sent.
CREATE INDEX message_deliveries_agent_client
	ON message_deliveries (agent_id, client_id, message_id);
`;
