/**
 * The task snapshot the owner's task panel reads (design §5, §7).
 *
 * A separate route from `/api/snapshot` for the same reason presence is: the
 * timeline is paged history and this is a short list the owner acts on, and a
 * panel refetching on every claim must not drag a page of updates along with it.
 *
 * **The open tasks are read separately from the finished ones**, which is the
 * one decision in this file worth stating. A single "newest 50 tasks" query on a
 * project with a long history would answer with fifty completed tasks and hide
 * the one thing the panel exists to show. So `todo` and `claimed` come back in
 * full (up to the domain's own cap) and the finished tail is deliberately short:
 * what is outstanding can never be crowded out by what is over.
 *
 * Like every snapshot it is stamped with the stream cursor it is good to, by the
 * shared handler in `./snapshot.ts`.
 */
import { context, listTasks, type DomainContext } from '$domain';
import type { SnapshotQuery } from './snapshot';

/**
 * The domain's own shape, named without importing `$db`.
 *
 * Recovered from the function's signature rather than re-declared, so the wire
 * format cannot drift from what the domain actually returns.
 */
export type SnapshotTasks = ReturnType<typeof listTasks>;

/** Everything the task panel renders. */
export type TasksSnapshot = { tasks: SnapshotTasks };

/**
 * How much finished work rides along.
 *
 * Enough to see what just happened, not enough to become a second timeline —
 * that is what the feed is for.
 */
export const TASKS_DONE_LIMIT = 20;

/** The tasks of one project, or of every project when the query names none. */
export function readTasksSnapshot(
	query: SnapshotQuery = { limit: TASKS_DONE_LIMIT },
	ctx: DomainContext = context()
): TasksSnapshot {
	const project = query.project;
	const open = [
		...listTasks(ctx, { project, state: 'todo', limit: query.limit }),
		...listTasks(ctx, { project, state: 'claimed', limit: query.limit })
	];
	const over = [
		...listTasks(ctx, { project, state: 'done', limit: TASKS_DONE_LIMIT }),
		...listTasks(ctx, { project, state: 'cancelled', limit: TASKS_DONE_LIMIT })
	];

	// One list, newest first: four queries are an implementation detail, and a
	// client sorting them itself would be a second place the order is decided.
	return { tasks: [...open, ...over].sort((left, right) => right.seq - left.seq) };
}
