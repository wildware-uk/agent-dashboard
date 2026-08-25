/**
 * `approvals` (design §3, §5).
 *
 * The approval gate is durable because the answer lives in this table rather
 * than in a socket: an agent that crashes mid-wait comes back, reads the row,
 * and carries on. Two guarantees come from here:
 *
 * - `decideApproval` only fires on a `pending` row, so a decision, a UI cancel
 *   and the expiry sweeper cannot fight over the same approval.
 * - `expireApprovals` returns what it changed, so the event bus can unblock
 *   exactly those waiters.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { jsonOf, jsonText, orNull } from './rows';
import type { Approval, ApprovalState } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	project_id: string | null;
	update_id: string | null;
	question: string;
	options: string | null;
	state: ApprovalState;
	expires_at: number;
	decided_at: number | null;
	decided_value: string | null;
};

const COLUMNS = `seq, id, agent_id, project_id, update_id, question, options, state, expires_at,
	decided_at, decided_value`;

function toApproval(row: Row): Approval {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		projectId: row.project_id,
		updateId: row.update_id,
		question: row.question,
		options: jsonOf<string[]>(row.options),
		state: row.state,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at,
		decidedValue: row.decided_value
	};
}

export type NewApproval = {
	id?: string;
	agentId: string;
	projectId?: string | null;
	updateId?: string | null;
	question: string;
	/** The buttons the owner is offered. Absent means a plain approve/reject. */
	options?: readonly string[] | null;
	/** From the tool's `timeout_s`; the sweeper flips the row when it passes. */
	expiresAt: number;
	state?: ApprovalState;
};

export function insertApproval(db: Db, input: NewApproval): Approval {
	const row = {
		id: input.id ?? newId(),
		agent_id: input.agentId,
		project_id: orNull(input.projectId),
		update_id: orNull(input.updateId),
		question: input.question,
		options: input.options ? jsonText([...input.options]) : null,
		state: input.state ?? 'pending',
		expires_at: input.expiresAt
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO approvals
				(id, agent_id, project_id, update_id, question, options, state, expires_at)
			 VALUES
				(:id, :agent_id, :project_id, :update_id, :question, :options, :state, :expires_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toApproval(inserted);
}

export function findApprovalById(db: Db, id: string): Approval | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).get(id);
	return row && toApproval(row);
}

export type ApprovalQuery = {
	state?: ApprovalState;
	agentId?: string;
	projectId?: string;
	/** Default 100. */
	limit?: number;
};

/** Approvals newest first: the sticky banner reads the pending ones. */
export function listApprovals(db: Db, query: ApprovalQuery = {}): Approval[] {
	const params = {
		state: orNull(query.state),
		agent_id: orNull(query.agentId),
		project_id: orNull(query.projectId),
		limit: query.limit ?? 100
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM approvals
			 WHERE (:state IS NULL OR state = :state)
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			   AND (:project_id IS NULL OR project_id = :project_id)
			 ORDER BY seq DESC
			 LIMIT :limit`
		)
		.all(params)
		.map(toApproval);
}

/** Every state a pending approval can be moved to. */
export type ApprovalDecision = {
	state: Exclude<ApprovalState, 'pending'>;
	/** Which option the owner picked, when the agent offered options. */
	value?: string | null;
	at?: number;
};

/**
 * Decide a pending approval.
 *
 * @returns the decided row, or `undefined` if it was already decided, expired or
 *   cancelled — so exactly one caller publishes `approval.decided`.
 */
export function decideApproval(
	db: Db,
	id: string,
	decision: ApprovalDecision
): Approval | undefined {
	const params = {
		id,
		state: decision.state,
		value: orNull(decision.value),
		at: decision.at ?? Date.now()
	};

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE approvals SET state = :state, decided_value = :value, decided_at = :at
			 WHERE id = :id AND state = 'pending'
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toApproval(row);
}

/**
 * Time out every pending approval whose deadline has passed.
 *
 * @returns the rows it changed, so the caller can wake the agents parked on
 *   exactly those approvals.
 */
export function expireApprovals(db: Db, options: { now?: number; at?: number } = {}): Approval[] {
	const now = options.now ?? Date.now();
	const params = { now, at: options.at ?? now };

	return db
		.prepare<typeof params, Row>(
			`UPDATE approvals SET state = 'timeout', decided_at = :at
			 WHERE state = 'pending' AND expires_at <= :now
			 RETURNING ${COLUMNS}`
		)
		.all(params)
		.map(toApproval);
}
