/**
 * `GET /api/snapshot/agents` — who is online right now (design §4, §7).
 *
 * The right rail's own read. Presence is derived from heartbeats rather than
 * stored (§4), so this has no query, no pages and no cache: it is the answer to
 * "who has beaten within the window", true at the instant it was asked.
 *
 * Like the other snapshots it carries the `seq` it is good to, so the rail can
 * apply it and then treat later `agent.presence` frames as a reason to ask
 * again. It is a separate route from `/api/snapshot` because a client refetching
 * presence every few seconds must not drag the timeline along with it.
 */
import { createSnapshotHandler, readAgentsSnapshot } from '../../../../stream';
import type { RequestHandler } from './$types';

const snapshot = createSnapshotHandler({ read: () => readAgentsSnapshot() });

export const GET: RequestHandler = (event) => snapshot(event);
