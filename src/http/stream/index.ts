/**
 * Public entry point for the live transport (design §4, §11 step 7).
 *
 * `GET /api/stream` is one SSE connection carrying every event type, tagged with
 * the global event sequence; `GET /api/snapshot` is how a client that was told
 * to `resync` rebuilds state. The route files under `src/http/routes/api/` are
 * mounts over these functions, so the protocol is testable without a server.
 *
 * ```ts
 * import { createStreamHandler, createSnapshotHandler, readFullSnapshot } from '$http/stream';
 * ```
 *
 * The nginx `proxy_buffering off` requirement is documented at the route itself
 * (`src/http/routes/api/stream/+server.ts`) and in the README.
 */
export {
	HEARTBEAT_MS,
	LAST_EVENT_ID_HEADER,
	LAST_EVENT_ID_PARAM,
	RETRY_MS,
	createStreamHandler,
	readCursor
} from './stream';
export type { StreamHandler, StreamHandlerOptions, StreamRequestEvent } from './stream';
export {
	SNAPSHOT_DEFAULT_LIMIT,
	createSnapshotHandler,
	readFullSnapshot,
	readSnapshotQuery,
	readUpdatesSnapshot
} from './snapshot';
export type {
	FullSnapshot,
	Snapshot,
	SnapshotHandlerOptions,
	SnapshotProjects,
	SnapshotQuery,
	SnapshotReader,
	SnapshotRequestEvent,
	SnapshotUpdates,
	UpdatesSnapshot
} from './snapshot';
export {
	RESYNC_EVENT,
	SSE_HEADERS,
	commentFrame,
	eventFrame,
	resyncFrame,
	retryFrame
} from './frames';
export type { Resync } from './frames';
export { ownerAuthenticated, unauthenticatedResponse } from './owner';
export type { OwnerCheck, OwnerRequest } from './owner';
