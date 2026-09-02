/**
 * Tasks: the work the owner hands out and agents pick up (design §3, §5, §7).
 *
 * ## The claim is one statement, and that is the whole design
 *
 * Two agents beating on the same queue will reach for the same task, and the
 * only defence that survives that is a single conditional write. {@link claimTask}
 * is `UPDATE tasks SET state='claimed' … WHERE id = ? AND state = 'todo'`
 * (`src/db/tasks.ts`), so SQLite decides the winner: one call updates a row, the
 * others update nothing. There is no read-then-write gap in the claim itself for
 * a racer to slip into, and no path where a task ends up with two owners.
 * {@link completeTask} works the same way — "is this still your claim" is part of
 * its statement rather than a read before it.
 *
 * The loser is then told what happened by *re-reading* the row — which is
 * exactly the right way round. The read is only there to write a sentence, so a
 * state that changed again in between makes the message better rather than the
 * outcome wrong; the outcome was already settled by the failed update.
 *
 * ## What is checked before the claim, and why that is still safe
 *
 * A task the owner targeted at one agent (design §7) may only be claimed by that
 * agent, and that check is a read before the write rather than part of it. It is
 * not a race: the assignee is changed by the owner in a browser, not by racing
 * agents, and the guarantee that matters — *exactly one claimant* — comes from
 * the conditional update regardless. The worst a concurrent reassignment can do
 * is refuse a claim that would have been allowed a moment later, which the agent
 * retries.
 *
 * ## Events
 *
 * One event per write, and only two names: `task.created` when a task appears,
 * `task.updated` for every state change afterwards — claimed, done, cancelled,
 * reassigned. The browser refetches the list on either (design §4), so the
 * payload carries identifiers plus the new `state` and assignee, which is enough
 * for a subscriber to decide whether it cares before asking for anything.
 */
import {
	assignTask as assignTaskRow,
	broadcastTask as broadcastTaskRow,
	cancelTask as cancelTaskRow,
	claimTask as claimTaskRow,
	completeTask as completeTaskRow,
	countBroadcastTasks,
	findAgentById,
	findTaskById,
	insertTask,
	listTasks as listTaskRows,
	type Task,
	type TaskState,
	type Update
} from '$db';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { projectsForAgent } from './messages';
import { resolveProject } from './projects';
import { requiredText, optionalText } from './text';
import { postUpdate } from './updates';

/** Long enough for a real instruction, short enough to read in a rail. */
export const TASK_TITLE_MAX_LENGTH = 200;
/** The brief: what to do, and how the owner will know it is done. */
export const TASK_BODY_MAX_LENGTH = 10_000;
/** What the agent reports back. Room for a summary, not for a transcript. */
export const TASK_RESULT_MAX_LENGTH = 10_000;

/** How many tasks a list returns when the caller does not say. */
export const TASK_DEFAULT_LIMIT = 100;
/** The most one list will ever return, however large a limit is asked for. */
export const TASK_MAX_LIMIT = 200;

/**
 * The states that still count as work (design §5).
 *
 * `todo` and `claimed`: one is waiting to be picked up, the other is in
 * progress. Both are things an agent still has to do, which is what a heartbeat
 * count means.
 */
export const OPEN_TASK_STATES: readonly TaskState[] = ['todo', 'claimed'];

export type CreateTaskInput = {
	/** A project slug or id, as everywhere else in the domain. */
	project: string;
	title: string;
	body?: string | null;
	/**
	 * The agent this is for, if whoever created it targeted one (design §7).
	 *
	 * Omit — or pass `null` — to leave it on the queue for whoever claims it
	 * first. Unlike every other `agentId` in this domain this is an argument
	 * rather than a token identity, because the caller is naming who the work is
	 * *for* rather than who they are: the owner assigns, and an agent that has
	 * discovered work either takes it (its own id) or leaves it for the fleet.
	 */
	agentId?: string | null;
	/**
	 * Send it to the project's agents the moment it exists (migration 010).
	 *
	 * The one-step version of create-then-{@link broadcastTask}, and it exists
	 * because handing something over is one act: the owner types a sentence and
	 * expects whoever is around to pick it up. Two writes would publish a
	 * `task.created` that no agent should act on and then a `task.updated` that
	 * they should, which is a race for anything listening.
	 *
	 * Refused alongside `agentId`: naming an agent and offering it to everybody
	 * are different instructions, and doing both would mean the assignee's own
	 * claim races the fleet's.
	 */
	broadcast?: boolean;
};

/** Put a task on a project's list and announce it. */
export function createTask(ctx: DomainContext, input: CreateTaskInput): Task {
	const project = resolveProject(ctx, input.project);
	const title = requiredText(input.title, 'title', TASK_TITLE_MAX_LENGTH);
	const body = optionalText(input.body, 'body', TASK_BODY_MAX_LENGTH);
	// Checked before the insert, so a typo in an assignee cannot leave a task
	// filed against an agent that does not exist.
	const agentId = assignee(ctx, input.agentId ?? null);

	if (input.broadcast && agentId !== null) {
		throw invalid('assign a task to an agent or offer it to the project, not both');
	}

	const task = insertTask(ctx.db, {
		projectId: project.id,
		agentId,
		title,
		body: body ?? '',
		createdAt: ctx.now(),
		broadcastAt: input.broadcast ? ctx.now() : null
	});

	announce(ctx, 'task.created', task);
	return task;
}

export type ListTasksInput = {
	/** A project slug or id. Omit for every project's tasks. */
	project?: string;
	state?: TaskState;
	/**
	 * Only this agent's tasks — what `list_tasks({mine: true})` resolves to
	 * (design §5). Unassigned tasks are nobody's, so they are not "mine".
	 */
	agentId?: string;
	/** Defaults to {@link TASK_DEFAULT_LIMIT}, capped at {@link TASK_MAX_LIMIT}. */
	limit?: number;
};

/** The task list, newest first. */
export function listTasks(ctx: DomainContext, input: ListTasksInput = {}): Task[] {
	const projectId = input.project === undefined ? undefined : resolveProject(ctx, input.project).id;

	return listTaskRows(ctx.db, {
		projectId,
		state: input.state,
		agentId: input.agentId,
		limit: pageLimit(input.limit)
	});
}

export type ClaimTaskInput = {
	taskId: string;
	/** From the bearer token. There is no argument for it (design §5). */
	agentId: string;
};

/**
 * Take a task off the queue for one agent.
 *
 * @throws {DomainError} `not_found` for an unknown task; `invalid_argument` if
 *   the task was targeted at a different agent; `conflict` — "already claimed",
 *   "already finished", "was cancelled" — when the state refuses the claim,
 *   which is what the loser of a race is told.
 */
export function claimTask(ctx: DomainContext, input: ClaimTaskInput): Task {
	const task = existing(ctx, input.taskId);
	// Only while it is still on the queue. Once a task is claimed its `agent_id`
	// *is* the claimant, so reading a targeting refusal out of it afterwards would
	// tell the loser of a race the wrong story — the refusal it needs is "already
	// claimed", which the conditional update below produces.
	if (task.state === 'todo' && task.agentId !== null && task.agentId !== input.agentId) {
		throw invalid(`task ${task.id} is assigned to another agent`);
	}

	const claimed = claimTaskRow(ctx.db, task.id, input.agentId, ctx.now());
	// The update updated nothing, so somebody else got there first — or the task
	// was never claimable. Re-read: our copy is by definition out of date.
	if (!claimed) throw refuseClaim(findTaskById(ctx.db, task.id) ?? task);

	announce(ctx, 'task.updated', claimed);
	return claimed;
}

export type CompleteTaskInput = {
	taskId: string;
	/** From the bearer token. Must be the agent holding the claim. */
	agentId: string;
	/** What the agent did, as the owner will read it. */
	result: string;
	/**
	 * Also post the result to the project's timeline (design §5).
	 *
	 * A finished task is usually worth a card, but not always — a batch of ten
	 * small ones would bury the feed — so the agent says which this was.
	 */
	postUpdate?: boolean;
};

/** A finished task, and the update it posted if it was asked to post one. */
export type CompletedTask = { task: Task; update: Update | null };

/**
 * Finish the task this agent claimed.
 *
 * The claim check is part of the same statement as the write (`src/db/tasks.ts`),
 * so there is no window in which a task is completed by an agent that no longer
 * holds it.
 *
 * @throws {DomainError} `not_found` for an unknown task; `invalid_argument` if
 *   another agent holds the claim; `conflict` if nobody claimed it, or it is
 *   already over.
 */
export function completeTask(ctx: DomainContext, input: CompleteTaskInput): CompletedTask {
	// Validated first: a blank result must not end a claim the agent then has no
	// way to report against.
	const result = requiredText(input.result, 'result', TASK_RESULT_MAX_LENGTH);
	const task = existing(ctx, input.taskId);

	const done = completeTaskRow(ctx.db, task.id, {
		result,
		at: ctx.now(),
		agentId: input.agentId
	});
	if (!done) throw refuseCompletion(findTaskById(ctx.db, task.id) ?? task, input.agentId);

	announce(ctx, 'task.updated', done);

	// After the completion, deliberately: the update is a report of work that is
	// already recorded as finished, and posting first would leave a card claiming
	// a completion that a conflict then refused.
	const update = input.postUpdate
		? postUpdate(ctx, {
				project: done.projectId,
				agentId: input.agentId,
				title: `Completed: ${done.title}`,
				body: result,
				level: 'success'
			})
		: null;

	return { task: done, update };
}

/**
 * Cancel a task the owner has changed their mind about.
 *
 * @throws {DomainError} `not_found` for an unknown task, `conflict` for one that
 *   has already finished or already been cancelled. Deliberately not idempotent:
 *   silence would tell the owner their click landed on a task that is still
 *   running.
 */
export function cancelTask(ctx: DomainContext, taskId: string): Task {
	const task = existing(ctx, taskId);
	const cancelled = cancelTaskRow(ctx.db, task.id, ctx.now());
	if (!cancelled) {
		throw conflict(`task ${task.id} is ${task.state} and cannot be cancelled`);
	}

	announce(ctx, 'task.updated', cancelled);
	return cancelled;
}

/**
 * Point an open task at an agent, or at nobody (design §7).
 *
 * State is untouched: assigning a `todo` task leaves it claimable — by that
 * agent alone — and assigning a `claimed` one hands the work over without
 * pretending it was never started.
 *
 * @throws {DomainError} `not_found` for an unknown task or agent, `conflict` for
 *   work that is already over.
 */
export function assignTask(ctx: DomainContext, taskId: string, agentId: string | null): Task {
	const task = existing(ctx, taskId);
	if (!OPEN_TASK_STATES.includes(task.state)) {
		throw conflict(`task ${task.id} is ${task.state}, so there is nothing left to assign`);
	}

	const target = assignee(ctx, agentId);
	// The row was just read and this is a single-process deployment (design §2),
	// so a missing row here would be a bug rather than a race.
	const assigned = assignTaskRow(ctx.db, task.id, target)!;

	announce(ctx, 'task.updated', assigned);
	return assigned;
}

/**
 * How much work is waiting for one agent — the `open_tasks` a heartbeat reports
 * (design §5).
 *
 * Two things, and the second one is newer than the design:
 *
 * 1. **Its own tasks.** An unassigned task on the queue is not work this agent
 *    has been given, and a count that included every one of them would tell
 *    every agent in the deployment it had something to do.
 * 2. **Work broadcast to a project it works in.** {@link broadcastTask} is the
 *    owner saying "somebody on this project take this", which is a different
 *    act from a task that merely happens to have no assignee — so rule 1 keeps
 *    its teeth and the owner still has a way to reach a project's agents
 *    without picking one by hand. `claimTask` settles the fan-out: one winner,
 *    a clean `conflict` for the rest.
 *
 * Which projects an agent "works in" is {@link projectsForAgent}'s derivation —
 * updates posted, tasks assigned, threads spoken in — the same one the live
 * stream already scopes unread messages by, so an agent is never woken by a
 * project it has nothing to do with. An agent with no history at all hears
 * about every broadcast, for the same reason it hears about every message: a
 * new agent must not be deaf to the first work ever offered to it.
 */
export function countOpenTasks(
	ctx: DomainContext,
	agentId: string,
	/**
	 * What the caller has explicitly subscribed to.
	 *
	 * Only the broadcast half is scoped by it — an assignment is work handed to
	 * this agent by name, and a heartbeat that hid it because the session said it
	 * was working elsewhere would lose the task rather than defer it.
	 *
	 * An explicit answer always wins over the derived one, exactly as it does for
	 * {@link countUnreadMessagesInScope}: a list means those projects, `null`
	 * means every project, and `undefined` means "work it out from what I have
	 * done".
	 */
	subscribed?: readonly string[] | null
): number {
	let open = 0;
	for (const state of OPEN_TASK_STATES) {
		// A count rather than a page, so the limit is "all of them": a heartbeat
		// reporting "100" because that was the page size would be a lie an agent
		// cannot see through.
		open += listTaskRows(ctx.db, { agentId, state, limit: Number.MAX_SAFE_INTEGER }).length;
	}

	// `null` means every project, from a caller that asked for the lot or from a
	// derivation that found no history — and every project is `undefined` to the
	// row layer, which takes "these ones" or nothing.
	const scope = subscribed === undefined ? projectsForAgent(ctx, agentId) : subscribed;
	return open + countBroadcastTasks(ctx.db, scope ?? undefined);
}

/**
 * Send a `todo` task out to the agents of its project, or take it back.
 *
 * Only `todo` work can go out. A claimed task already has somebody on it, and
 * announcing it would put the rest of the fleet into a race they must lose;
 * `conflict` rather than a silent no-op, because the button that sent it is
 * about to tell the owner it worked.
 *
 * @throws {DomainError} `not_found` for an unknown task, `conflict` for a task
 *   that is no longer `todo`.
 */
export function broadcastTask(ctx: DomainContext, taskId: string, on = true): Task {
	const task = existing(ctx, taskId);
	if (task.state !== 'todo') {
		throw conflict(`task ${task.id} is ${task.state}, so there is nobody left to offer it to`);
	}

	const broadcast = broadcastTaskRow(ctx.db, task.id, on ? ctx.now() : null)!;

	announce(ctx, 'task.updated', broadcast);
	return broadcast;
}

/**
 * One task, or `null`.
 *
 * `null` rather than a throw, because the page that reads it wants a 404 of its
 * own and an unknown id is a URL somebody typed rather than a bug.
 */
export function findTask(ctx: DomainContext, taskId: string): Task | null {
	return findTaskById(ctx.db, taskId) ?? null;
}

/** The task, or a `not_found` naming the id the caller asked for. */
function existing(ctx: DomainContext, taskId: string): Task {
	const task = findTaskById(ctx.db, taskId);
	if (!task) throw notFound(`no such task: ${taskId}`);
	return task;
}

/** An agent id that exists, or `null`. Anything else is a `not_found`. */
function assignee(ctx: DomainContext, agentId: string | null): string | null {
	if (agentId === null) return null;
	if (!findAgentById(ctx.db, agentId)) throw notFound(`no such agent: ${agentId}`);
	return agentId;
}

/**
 * Why a claim failed, in a sentence the losing agent can act on.
 *
 * Each state gets its own wording because each has a different answer: another
 * agent has it (find another task), it is finished (nothing to do), it was
 * cancelled (the owner withdrew it).
 */
function refuseClaim(task: Task) {
	switch (task.state) {
		case 'claimed':
			return conflict(`task ${task.id} is already claimed by another agent`);
		case 'done':
			return conflict(`task ${task.id} is already finished`);
		case 'cancelled':
			return conflict(`task ${task.id} was cancelled`);
		default:
			return conflict(`task ${task.id} is no longer available to claim`);
	}
}

/** Why a completion failed. Same principle as {@link refuseClaim}. */
function refuseCompletion(task: Task, agentId: string) {
	if (task.state === 'claimed' && task.agentId !== agentId) {
		return invalid(`task ${task.id} is claimed by another agent`);
	}

	switch (task.state) {
		case 'todo':
			return conflict(`task ${task.id} has not been claimed; claim it first`);
		case 'done':
			return conflict(`task ${task.id} is already finished`);
		case 'cancelled':
			return conflict(`task ${task.id} was cancelled`);
		default:
			return conflict(`task ${task.id} cannot be completed`);
	}
}

/** One event per write, carrying identifiers plus what a subscriber filters on. */
function announce(ctx: DomainContext, type: 'task.created' | 'task.updated', task: Task): void {
	ctx.bus.publish(type, {
		taskId: task.id,
		projectId: task.projectId,
		agentId: task.agentId,
		state: task.state
	});
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return TASK_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
	return Math.min(limit, TASK_MAX_LIMIT);
}
