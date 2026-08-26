/**
 * `GET /api/snapshot/tasks` — the owner's task list (design §5, §7).
 *
 * Takes `?project=` and nothing else: a task list is short, so it has no pages
 * and no cursor. Like the other snapshots it carries the `seq` it is good to, so
 * the panel can apply it and then treat later `task.created` and `task.updated`
 * frames as a reason to ask again.
 */
import { createSnapshotHandler, readTasksSnapshot } from '../../../../stream';
import type { RequestHandler } from './$types';

const snapshot = createSnapshotHandler({ read: (query) => readTasksSnapshot(query) });

export const GET: RequestHandler = (event) => snapshot(event);
