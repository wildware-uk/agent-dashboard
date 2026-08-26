/**
 * `GET /api/snapshot/requests` — what is waiting on the owner (design §5, §7).
 *
 * The sticky banner's read. Takes no query at all: a request is aimed at the
 * owner rather than at a project, so filtering it by the project the browser
 * happens to be looking at would hide an agent that is stopped dead.
 */
import { createSnapshotHandler, readRequestsSnapshot } from '../../../../stream';
import type { RequestHandler } from './$types';

const snapshot = createSnapshotHandler({ read: () => readRequestsSnapshot() });

export const GET: RequestHandler = (event) => snapshot(event);
