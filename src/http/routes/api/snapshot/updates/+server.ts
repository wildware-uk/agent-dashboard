/**
 * `GET /api/snapshot/updates` — the timeline alone (design §4).
 *
 * The same snapshot contract as `../+server.ts`, minus the project list: what a
 * client wants when it is paging into the past with `?cursor=`, or refetching one
 * project after a `resync`, and already knows the sidebar.
 */
import { createSnapshotHandler, readUpdatesSnapshot } from '../../../../stream';
import type { RequestHandler } from './$types';

const snapshot = createSnapshotHandler({ read: readUpdatesSnapshot });

export const GET: RequestHandler = (event) => snapshot(event);
