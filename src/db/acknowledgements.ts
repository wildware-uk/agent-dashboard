/**
 * `acknowledgements` (migration 013).
 *
 * One row per (agent, thing), upserted. The unique indexes are what make that
 * true, so {@link upsertAcknowledgement} is a single statement with an
 * `ON CONFLICT` rather than a read followed by a write — two agents
 * acknowledging in the same tick must not produce two rows one of which nobody
 * will ever see again.
 *
 * Nothing here decides what a valid target is. Exactly-one-of is the domain's
 * rule; this layer stores what it is given.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { AckState, Acknowledgement } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	message_id: string | null;
	task_id: string | null;
	state: AckState;
	created_at: number;
	updated_at: number;
};

const COLUMNS = `seq, id, agent_id, message_id, task_id, state, created_at, updated_at`;

function toAcknowledgement(row: Row): Acknowledgement {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		messageId: row.message_id,
		taskId: row.task_id,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export type NewAcknowledgement = {
	id?: string;
	agentId: string;
	messageId?: string | null;
	taskId?: string | null;
	state: AckState;
	at?: number;
};

/**
 * Record what an agent is saying about one thing, replacing whatever it said
 * before.
 *
 * `created_at` survives the conflict and `updated_at` moves, so the pair keeps
 * saying "acknowledged then, finished now" however many times the state is
 * rewritten. Which index the conflict lands on depends on which target is set,
 * so both are named.
 */
export function upsertAcknowledgement(db: Db, input: NewAcknowledgement): Acknowledgement {
	const row = {
		id: input.id ?? newId(),
		agent_id: input.agentId,
		message_id: orNull(input.messageId),
		task_id: orNull(input.taskId),
		state: input.state,
		at: input.at ?? Date.now()
	};

	const upserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO acknowledgements
			   (id, agent_id, message_id, task_id, state, created_at, updated_at)
			 VALUES (:id, :agent_id, :message_id, :task_id, :state, :at, :at)
			 ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL
			   DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
			 ON CONFLICT (agent_id, task_id) WHERE task_id IS NOT NULL
			   DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toAcknowledgement(upserted);
}

export type AcknowledgementQuery = {
	messageIds?: readonly string[];
	taskIds?: readonly string[];
};

/**
 * Every acknowledgement on the things named, oldest first.
 *
 * Takes lists because the caller is a page about to render a thread or a board
 * and wants them in one read: a query per message would be a fan-out that grows
 * with the size of the conversation.
 *
 * An empty query is an empty answer, never everything — "the acknowledgements on
 * these none things" is nothing, and a page that asked for nothing must not be
 * handed the deployment's whole history.
 */
export function listAcknowledgements(db: Db, query: AcknowledgementQuery = {}): Acknowledgement[] {
	const clauses: string[] = [];
	const params: string[] = [];

	if (query.messageIds?.length) {
		clauses.push(`message_id IN (${query.messageIds.map(() => '?').join(', ')})`);
		params.push(...query.messageIds);
	}
	if (query.taskIds?.length) {
		clauses.push(`task_id IN (${query.taskIds.map(() => '?').join(', ')})`);
		params.push(...query.taskIds);
	}
	if (clauses.length === 0) return [];

	return db
		.prepare<string[], Row>(
			`SELECT ${COLUMNS} FROM acknowledgements
			  WHERE ${clauses.join(' OR ')}
			  ORDER BY seq ASC`
		)
		.all(...params)
		.map(toAcknowledgement);
}
