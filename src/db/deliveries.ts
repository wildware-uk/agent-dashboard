/**
 * `message_deliveries` (migration 018): which agent has actually been handed
 * which message.
 *
 * One row per (message, agent), inserted with `ON CONFLICT DO NOTHING` — the
 * server may push the same message twice across two connections, and the second
 * push is the same fact rather than a second one. The insert therefore reports
 * whether it was the first, which is what lets only the first publish an event.
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
};

const COLUMNS = `seq, id, message_id, agent_id, delivered_at`;

function toDelivery(row: Row): MessageDelivery {
	return {
		seq: row.seq,
		id: row.id,
		messageId: row.message_id,
		agentId: row.agent_id,
		deliveredAt: row.delivered_at
	};
}

/**
 * Record that one message reached one agent.
 *
 * @returns the row, and whether this call was the one that created it.
 */
export function recordDelivery(
	db: Db,
	input: { messageId: string; agentId: string; at?: number }
): { delivery: MessageDelivery; created: boolean } {
	const row = {
		id: newId(),
		message_id: input.messageId,
		agent_id: input.agentId,
		delivered_at: input.at ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO message_deliveries (id, message_id, agent_id, delivered_at)
			 VALUES (:id, :message_id, :agent_id, :delivered_at)
			 ON CONFLICT (message_id, agent_id) DO NOTHING
			 RETURNING ${COLUMNS}`
		)
		.get(row);

	if (inserted) return { delivery: toDelivery(inserted), created: true };

	// Already delivered: hand back the row that was there, so a caller never has
	// to ask a second question to find out when it happened.
	const existing = db
		.prepare<[string, string], Row>(
			`SELECT ${COLUMNS} FROM message_deliveries WHERE message_id = ? AND agent_id = ?`
		)
		.get(input.messageId, input.agentId)!;
	return { delivery: toDelivery(existing), created: false };
}

/** Which of these messages this agent has already been handed. */
export function deliveredMessageIds(
	db: Db,
	agentId: string,
	messageIds: readonly string[]
): Set<string> {
	if (messageIds.length === 0) return new Set();

	const placeholders = messageIds.map(() => '?').join(', ');
	const rows = db
		.prepare<unknown[], { message_id: string }>(
			`SELECT message_id FROM message_deliveries
			  WHERE agent_id = ? AND message_id IN (${placeholders})`
		)
		.all(agentId, ...messageIds);

	return new Set(rows.map((row) => row.message_id));
}

/** Every delivery on these messages, oldest first — what a thread renders. */
export function listDeliveries(db: Db, messageIds: readonly string[]): MessageDelivery[] {
	if (messageIds.length === 0) return [];

	const placeholders = messageIds.map(() => '?').join(', ');
	return db
		.prepare<unknown[], Row>(
			`SELECT ${COLUMNS} FROM message_deliveries
			  WHERE message_id IN (${placeholders})
			  ORDER BY seq`
		)
		.all(...messageIds)
		.map(toDelivery);
}
