/**
 * `tasks` (design §3, §5).
 *
 * The one thing this file exists to get right is `claimTask`: a single
 * conditional UPDATE, so two agents racing for the same task produce one winner
 * and one clean miss rather than a task with two owners.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { orNull } from './rows';
import type { Task, TaskState } from './types';

type Row = {
	seq: number;
	id: string;
	project_id: string;
	agent_id: string | null;
	title: string;
	body: string;
	state: TaskState;
	created_at: number;
	claimed_at: number | null;
	done_at: number | null;
	result: string | null;
};

const COLUMNS = `seq, id, project_id, agent_id, title, body, state, created_at, claimed_at,
	done_at, result`;

function toTask(row: Row): Task {
	return {
		seq: row.seq,
		id: row.id,
		projectId: row.project_id,
		agentId: row.agent_id,
		title: row.title,
		body: row.body,
		state: row.state,
		createdAt: row.created_at,
		claimedAt: row.claimed_at,
		doneAt: row.done_at,
		result: row.result
	};
}

export type NewTask = {
	id?: string;
	projectId: string;
	/** Assigned up front, or left for whichever agent claims it. */
	agentId?: string | null;
	title: string;
	body?: string;
	state?: TaskState;
	createdAt?: number;
};

export function insertTask(db: Db, input: NewTask): Task {
	const row = {
		id: input.id ?? newId(),
		project_id: input.projectId,
		agent_id: orNull(input.agentId),
		title: input.title,
		body: input.body ?? '',
		state: input.state ?? 'todo',
		created_at: input.createdAt ?? Date.now()
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO tasks (id, project_id, agent_id, title, body, state, created_at)
			 VALUES (:id, :project_id, :agent_id, :title, :body, :state, :created_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toTask(inserted);
}

export function findTaskById(db: Db, id: string): Task | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id);
	return row && toTask(row);
}

export type TaskQuery = {
	projectId?: string;
	state?: TaskState;
	agentId?: string;
	/** Default 100. */
	limit?: number;
};

export function listTasks(db: Db, query: TaskQuery = {}): Task[] {
	const params = {
		project_id: orNull(query.projectId),
		state: orNull(query.state),
		agent_id: orNull(query.agentId),
		limit: query.limit ?? 100
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM tasks
			 WHERE (:project_id IS NULL OR project_id = :project_id)
			   AND (:state IS NULL OR state = :state)
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			 ORDER BY seq DESC
			 LIMIT :limit`
		)
		.all(params)
		.map(toTask);
}

/**
 * Claim a task for an agent.
 *
 * @returns the claimed task, or `undefined` when it was already claimed, done,
 *   cancelled or never existed. One statement, so the loser of a race gets a
 *   clean miss rather than a corrupt row (design §5).
 */
export function claimTask(
	db: Db,
	id: string,
	agentId: string,
	at: number = Date.now()
): Task | undefined {
	const row = db
		.prepare<[string, number, string], Row>(
			`UPDATE tasks SET state = 'claimed', agent_id = ?, claimed_at = ?
			 WHERE id = ? AND state = 'todo'
			 RETURNING ${COLUMNS}`
		)
		.get(agentId, at, id);

	return row && toTask(row);
}

/**
 * Finish a claimed task.
 *
 * Pass `agentId` to require that the caller is the agent holding the claim; the
 * check is part of the same statement, so there is no read-then-write gap.
 */
export function completeTask(
	db: Db,
	id: string,
	options: { result: string; at?: number; agentId?: string }
): Task | undefined {
	const params = {
		id,
		result: options.result,
		at: options.at ?? Date.now(),
		agent_id: orNull(options.agentId)
	};

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE tasks SET state = 'done', result = :result, done_at = :at
			 WHERE id = :id AND state = 'claimed'
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			 RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toTask(row);
}

/** Cancel a task that has not finished. `done_at` records when it stopped. */
export function cancelTask(db: Db, id: string, at: number = Date.now()): Task | undefined {
	const row = db
		.prepare<[number, string], Row>(
			`UPDATE tasks SET state = 'cancelled', done_at = ?
			 WHERE id = ? AND state IN ('todo', 'claimed')
			 RETURNING ${COLUMNS}`
		)
		.get(at, id);

	return row && toTask(row);
}

/** Set or clear the assignee without touching the task's state. */
export function assignTask(db: Db, id: string, agentId: string | null): Task | undefined {
	const row = db
		.prepare<[string | null, string], Row>(
			`UPDATE tasks SET agent_id = ? WHERE id = ? RETURNING ${COLUMNS}`
		)
		.get(agentId, id);

	return row && toTask(row);
}
