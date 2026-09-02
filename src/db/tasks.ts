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
	broadcast_at: number | null;
};

const COLUMNS = `seq, id, project_id, agent_id, title, body, state, created_at, claimed_at,
	done_at, result, broadcast_at`;

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
		result: row.result,
		broadcastAt: row.broadcast_at
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
	/**
	 * Sent to the project's agents as it is created.
	 *
	 * Here rather than left to a second write because the two are one act when
	 * the owner hands something over: a task that existed unbroadcast for a beat
	 * would publish `task.created` that no agent should act on, followed by a
	 * `task.updated` that they should.
	 */
	broadcastAt?: number | null;
};

export function insertTask(db: Db, input: NewTask): Task {
	const row = {
		id: input.id ?? newId(),
		project_id: input.projectId,
		agent_id: orNull(input.agentId),
		title: input.title,
		body: input.body ?? '',
		state: input.state ?? 'todo',
		created_at: input.createdAt ?? Date.now(),
		broadcast_at: orNull(input.broadcastAt)
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO tasks (id, project_id, agent_id, title, body, state, created_at, broadcast_at)
			 VALUES (:id, :project_id, :agent_id, :title, :body, :state, :created_at, :broadcast_at)
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
	/** Only tasks the owner has broadcast to a project's agents. */
	broadcast?: boolean;
	/** Default 100. */
	limit?: number;
};

export function listTasks(db: Db, query: TaskQuery = {}): Task[] {
	const params = {
		project_id: orNull(query.projectId),
		state: orNull(query.state),
		agent_id: orNull(query.agentId),
		broadcast: query.broadcast === undefined ? null : Number(query.broadcast),
		limit: query.limit ?? 100
	};

	return db
		.prepare<typeof params, Row>(
			`SELECT ${COLUMNS} FROM tasks
			 WHERE (:project_id IS NULL OR project_id = :project_id)
			   AND (:state IS NULL OR state = :state)
			   AND (:agent_id IS NULL OR agent_id = :agent_id)
			   AND (:broadcast IS NULL
			        OR (:broadcast = 1 AND broadcast_at IS NOT NULL)
			        OR (:broadcast = 0 AND broadcast_at IS NULL))
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

/**
 * Send a task out to its project's agents, or take it back off the wire.
 *
 * Only `todo` work can be broadcast: a claimed task already has somebody on it,
 * and announcing it would put every other agent into a race it must lose. The
 * conditional lives in the SQL rather than above it for the same reason
 * `claimTask`'s does — one statement is one verdict.
 */
export function broadcastTask(db: Db, id: string, at: number | null): Task | undefined {
	const row = db
		.prepare<[number | null, string], Row>(
			`UPDATE tasks SET broadcast_at = ?
			 WHERE id = ? AND state = 'todo'
			 RETURNING ${COLUMNS}`
		)
		.get(at, id);

	return row && toTask(row);
}

/**
 * How many broadcast `todo` tasks are open in a set of projects.
 *
 * Unassigned only: once somebody claims a broadcast task it stops being work
 * going spare, and counting it afterwards would keep telling the rest of the
 * fleet about a job that is already being done.
 *
 * An empty list counts nothing — the caller is saying "these projects", and an
 * empty "these" is not "all". A caller that means all of them passes
 * `undefined`.
 */
export function countBroadcastTasks(db: Db, projectIds?: readonly string[]): number {
	if (projectIds?.length === 0) return 0;

	const scope = projectIds ? `AND project_id IN (${projectIds.map(() => '?').join(', ')})` : '';
	const row = db
		.prepare<string[], { count: number }>(
			`SELECT COUNT(*) AS count FROM tasks
			 WHERE state = 'todo' AND agent_id IS NULL AND broadcast_at IS NOT NULL ${scope}`
		)
		.get(...(projectIds ? [...projectIds] : []))!;

	return row.count;
}
