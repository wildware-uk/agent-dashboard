/**
 * `GET /api/snapshot` — current state, stamped with the stream cursor it is good
 * to (design §4).
 *
 * This is the other half of the reconnect story in `../stream/+server.ts`: when
 * the client's `Last-Event-ID` has fallen out of the ring buffer the stream sends
 * one `resync`, and the client comes here to rebuild from scratch. A page that
 * has just loaded uses it the same way.
 *
 * Query: `?project=<slug|id>`, `?status=active|archived`, `?limit=`, `?cursor=`.
 *
 * The response carries `seq`: apply this state, then discard stream frames whose
 * `id:` is at or below it.
 */
import { createSnapshotHandler, readFullSnapshot } from '../../../stream';
import type { RequestHandler } from './$types';

const snapshot = createSnapshotHandler({ read: readFullSnapshot });

export const GET: RequestHandler = (event) => snapshot(event);
