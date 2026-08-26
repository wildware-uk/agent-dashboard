/**
 * `PATCH /api/tasks/[id]` — reassign or cancel one task (design §7).
 *
 * The two things the owner does to a task that already exists. Claiming and
 * completing belong to the agent doing the work (design §5), so there is
 * deliberately no route here that lets a browser mark work done.
 */
import { patchTaskHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const patch = patchTaskHandler();

export const PATCH: RequestHandler = (event) => patch(event);
