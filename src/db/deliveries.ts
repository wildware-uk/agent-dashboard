/**
 * `message_deliveries` (migration 018): which agent has actually been handed
 * which message.
 *
 * One row per (message, agent, client), inserted with `ON CONFLICT DO NOTHING`.
 * The client is the connection that was handed it (migration 019): two live
 * sessions holding one token are two deliveries, because they are two places
 * the message has to arrive, while one session reconnecting is still one.
 *
 * A connection that names no client — an older bridge — writes a row with
 * `client_id` NULL, and SQLite treats those as distinct, so they never conflict
 * with each other. Suppression for those callers lives in the connection
 * instead; these rows are only for the owner to read.
 *
 * The insert reports whether it was the first, which is what lets only the
 * first publish an event.
 *
 * Nothing here decides *when* a message counts as delivered. That is the
 * stream's business (`src/http/stream/agent.ts`); this layer stores the fact.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { MessageDelivery } from './types';

type Row = {
	seq: number;
	id: string;
	message_id: string;
	agent_id: string;
	delivered_at: number;
	client_id: string | null;
};

const COLUMNS = `seq, id, message_id, agent_id, delivered_at, client_id`;

function toDelivery(row: Row): MessageDelivery {
	return {
		seq: row.seq,
		id: row.id,
		messageId: row.message_id,
		agentId: row.agent_id,
		deliveredAt: row.delivered_at,
		clientId: row.client_id
	};
}

/**
 * Record that one message reached one agent.
 *
 * @returns the row, and whether this call was the one that created it.
 */
export function recordDelivery(
	db: Db,
	input: { messageId: string; agentId: string; clientId?: string | null; at?: number }
): { delivery: MessageDelivery; created: boolean } {
	const row = {
		id: newId(),
		message_id: input.messageId,
		agent_id: input.agentId,
		client_id: input.clientId ?? null,
		delivered_at: input.at ?? Date.now()
	};

	// A connection with no name cannot be told apart from another one, and SQLite
	// treats NULLs as distinct, so the unique index will not do it: check first,
	// or two anonymous connections leave two rows and the owner reads "delivered"
	// twice for one agent.
	if (row.client_id === null) {
		const already = db
			.prepare<[string, string], Row>(
				`SELECT ${COLUMNS} FROM message_deliveries
				  WHERE message_id = ? AND agent_id = ? AND client_id IS NULL`
			)
			.get(row.message_id, row.agent_id);
		if (already) return { delivery: toDelivery(already), created: false };
	}

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO message_deliveries (id, message_id, agent_id, client_id, delivered_at)
			 VALUES (:id, :message_id, :agent_id, :client_id, :delivered_at)
			 ON CONFLICT (message_id, agent_id, client_id) DO NOTHING
			 RETURNING ${COLUMNS}`
		)
		.get(row);

	if (inserted) return { delivery: toDelivery(inserted), created: true };

	// Already delivered to this client: hand back the row that was there, so a
	// caller never has to ask a second question to find out when it happened.
	const existing = db
		.prepare<[string, string, string | null, string | null], Row>(
			`SELECT ${COLUMNS} FROM message_deliveries
			  WHERE message_id = ? AND agent_id = ? AND (? IS NULL OR client_id = ?)`
		)
		.get(input.messageId, input.agentId, row.client_id, row.client_id)!;
	return { delivery: toDelivery(existing), created: false };
}

/**
 * Which of these messages this **client** has already been handed.
 *
 * Keyed by the connection rather than by the agent (migration 019): two
 * sessions sharing a token both have to be told, and asking "has the agent seen
 * it" was how one live session went silent while a dead one held the only
 * delivery there was.
 *
 * A caller with no client id gets an empty answer rather than the agent's whole
 * history: it has no durable identity, so it remembers within its own
 * connection instead.
 */
export function deliveredMessageIds(
	db: Db,
	agentId: string,
	clientId: string | null,
	messageIds: readonly string[]
): Set<string> {
	if (messageIds.length === 0 || clientId === null) return new Set();

	const placeholders = messageIds.map(() => '?').join(', ');
	const rows = db
		.prepare<unknown[], { message_id: string }>(
			`SELECT message_id FROM message_deliveries
			  WHERE agent_id = ? AND client_id = ? AND message_id IN (${placeholders})`
		)
		.all(agentId, clientId, ...messageIds);

	return new Set(rows.map((row) => row.message_id));
}

/**
 * Every delivery on these messages, oldest first — what a thread renders.
 *
 * **One row per agent**, not per connection. The owner wants to know that a
 * message reached scout; how many sockets scout had open is this file's
 * business and nobody else's, and two lines saying the same name would read as
 * a bug in the dashboard rather than as two sessions.
 */
export function listDeliveries(db: Db, messageIds: readonly string[]): MessageDelivery[] {
	if (messageIds.length === 0) return [];

	const placeholders = messageIds.map(() => '?').join(', ');
	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM message_deliveries
			  WHERE seq IN (
			    SELECT min(seq) FROM message_deliveries
			     WHERE message_id IN (${placeholders})
			     GROUP BY message_id, agent_id
			  )
			  ORDER BY seq`
		)
		.all(...messageIds)
		.map(toDelivery);
}
