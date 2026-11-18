/**
 * `approvals` — the owner-request table (design §3, §5).
 *
 * A request is durable because the answer lives in this table rather than in a
 * socket: an agent that crashes mid-wait comes back, reads the row, and carries
 * on. Three guarantees come from here:
 *
 * - `decideApproval` only fires on a `pending` row, so an answer, a UI dismiss
 *   and the expiry sweeper cannot fight over the same request.
 * - `expireApprovals` returns what it changed, so the event bus can unblock
 *   exactly those waiters.
 * - `countPendingApprovals` is one indexed count, so the heartbeat can carry it
 *   on every beat without a table scan.
 *
 * The `state` column keeps migration 001's vocabulary — `approved` and
 * `rejected` are the two settled values — while `answer` carries the structured
 * result for every kind. `$domain` presents that pair as one `answered` state;
 * this layer stores rows and does not interpret them.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { jsonOf, jsonText, orNull } from './rows';
import type { Approval, ApprovalState, RequestAnswer, RequestConfig, RequestKind } from './types';

type Row = {
	seq: number;
	id: string;
	agent_id: string;
	project_id: string | null;
	update_id: string | null;
	message_id: string | null;
	kind: RequestKind;
	question: string;
	detail: string | null;
	options: string | null;
	config: string | null;
	state: ApprovalState;
	expires_at: number;
	decided_at: number | null;
	decided_value: string | null;
	answer: string | null;
	edited_at: number | null;
	pinned: number;
};

const COLUMNS = `seq, id, agent_id, project_id, update_id, message_id, kind, question, detail, options, config,
	state, expires_at, decided_at, decided_value, answer, edited_at, pinned`;

function toApproval(row: Row): Approval {
	return {
		seq: row.seq,
		id: row.id,
		agentId: row.agent_id,
		projectId: row.project_id,
		updateId: row.update_id,
		messageId: row.message_id,
		kind: row.kind,
		question: row.question,
		detail: row.detail,
		options: jsonOf<string[]>(row.options),
		config: jsonOf<RequestConfig>(row.config),
		state: row.state,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at,
		decidedValue: row.decided_value,
		answer: jsonOf<RequestAnswer>(row.answer),
		editedAt: row.edited_at,
		pinned: row.pinned === 1
	};
}

export type NewApproval = {
	id?: string;
	agentId: string;
	projectId?: string | null;
	updateId?: string | null;
	/** The thread this was asked in (migration 022). */
	messageId?: string | null;
	/** Which of the five kinds (design §5). Defaults to `confirm`, as the column does. */
	kind?: RequestKind;
	question: string;
	/** The longer explanation the banner shows under the question. */
	detail?: string | null;
	/** The options the owner is offered. Absent for `text` and `confirm`. */
	options?: readonly string[] | null;
	/** Kind-specific knobs: placeholder, multiline, default, min, max. */
	config?: RequestConfig | null;
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
		message_id: orNull(input.messageId),
		kind: input.kind ?? 'confirm',
		question: input.question,
		detail: orNull(input.detail),
		options: input.options ? jsonText([...input.options]) : null,
		config: jsonText(input.config),
		state: input.state ?? 'pending',
		expires_at: input.expiresAt
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO approvals
				(id, agent_id, project_id, update_id, message_id, kind, question, detail, options, config, state,
				 expires_at)
			 VALUES
				(:id, :agent_id, :project_id, :update_id, :message_id, :kind, :question, :detail, :options, :config,
				 :state, :expires_at)
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
	/**
	 * Take the OLDEST rows rather than the newest.
	 *
	 * This matters precisely because `limit` truncates. The pending banner must
	 * show the agents blocked longest, so newest-first plus a cap silently hid
	 * exactly the rows it exists to surface. Default stays newest-first, which is
	 * what a general listing wants.
	 */
	oldestFirst?: boolean;
};

/** Approvals newest first: the sticky banner reads the pending ones. */
export function listApprovals(db: Db, query: ApprovalQuery = {}): Approval[] {
	const params = {
		state: orNull(query.state),
		agent_id: orNull(query.agentId),
		project_id: orNull(query.projectId),
		limit: query.limit ?? 100,
		// SQLite has no booleans; the CASE in the ORDER BY reads this as 0 or 1.
		oldest_first: query.oldestFirst === true ? 1 : 0
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM approvals
			 WHERE (:state IS NULL OR state = :state)
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			   AND (:project_id IS NULL OR project_id = :project_id)
			 ORDER BY CASE WHEN :oldest_first THEN seq END ASC,
			          CASE WHEN :oldest_first THEN NULL ELSE seq END DESC
			 LIMIT :limit`
		)
		.all(params)
		.map(toApproval);
}

/**
 * How many of this agent's requests are still waiting on the owner.
 *
 * A count rather than a list because that is all the heartbeat reports, and it
 * rides the `(agent_id, state)` index migration 002 adds — an agent beating
 * every thirty seconds must not cost a scan.
 */
export function countPendingApprovals(
	db: Db,
	agentId: string,
	/**
	 * Only approvals filed under these projects, plus the ones filed under none.
	 *
	 * Omit for every project, which is what a heartbeat wants: "is anything
	 * waiting on me anywhere" has to span the lot or it is a no that means yes.
	 * A live stream wants the narrow answer instead — see the domain.
	 *
	 * A request with no project is always counted. It belongs to the agent rather
	 * than to any project, so there is no scope that could exclude it and no
	 * session it would be wrong to tell.
	 */
	projectIds?: readonly string[]
): number {
	if (!projectIds) {
		return db
			.prepare<[string], { n: number }>(
				`SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND state = 'pending'`
			)
			.get(agentId)!.n;
	}

	// An empty scope still counts the project-less ones, which is why this is not
	// short-circuited to zero.
	const placeholders = projectIds.map(() => '?').join(', ');
	const params = [agentId, ...projectIds];

	return db
		.prepare<typeof params, { n: number }>(
			`SELECT COUNT(*) AS n FROM approvals
			  WHERE agent_id = ?
			    AND state = 'pending'
			    AND (project_id IS NULL${placeholders === '' ? '' : ` OR project_id IN (${placeholders})`})`
		)
		.get(...params)!.n;
}

/** Every state a pending approval can be moved to. */
export type ApprovalDecision = {
	state: Exclude<ApprovalState, 'pending'>;
	/** The scalar the decision produced, when there is one. */
	value?: string | null;
	/** The structured answer (design §5). The authority; `value` is a convenience. */
	answer?: RequestAnswer | null;
	at?: number;
};

/**
 * Decide a pending approval.
 *
 * @returns the decided row, or `undefined` if it was already decided, expired or
 *   cancelled — so exactly one caller publishes the settling event.
 */
/**
 * The asking agent rewrites its own question (migration 033).
 *
 * Pending only, and that is the whole safety of it: an answer is validated
 * against the row it was given, so a question whose options changed after it was
 * settled would make the record disagree with the decision. `$domain` checks who
 * is asking and what the new values may be; this writes what it is handed.
 */
export function editApproval(
	db: Db,
	id: string,
	edit: {
		question?: string;
		detail?: string | null;
		options?: string[] | null;
		config?: RequestConfig | null;
		editedAt: number;
	}
): Approval | undefined {
	const sets: string[] = ['edited_at = :edited_at'];
	const params: Record<string, string | number | null> = { id, edited_at: edit.editedAt };

	if (edit.question !== undefined) {
		sets.push('question = :question');
		params.question = edit.question;
	}
	if (edit.detail !== undefined) {
		sets.push('detail = :detail');
		params.detail = orNull(edit.detail);
	}
	if (edit.options !== undefined) {
		sets.push('options = :options');
		params.options = jsonText(edit.options);
	}
	if (edit.config !== undefined) {
		sets.push('config = :config');
		params.config = jsonText(edit.config);
	}

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE approvals SET ${sets.join(', ')}
			 WHERE id = :id AND state = 'pending'
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toApproval(row);
}

export function decideApproval(
	db: Db,
	id: string,
	decision: ApprovalDecision
): Approval | undefined {
	const params = {
		id,
		state: decision.state,
		value: orNull(decision.value),
		answer: jsonText(decision.answer),
		at: decision.at ?? Date.now()
	};

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE approvals
			 SET state = :state, decided_value = :value, answer = :answer, decided_at = :at
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
