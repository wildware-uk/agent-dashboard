/**
 * The pending-request snapshot the sticky banner reads (design §5, §7).
 *
 * Its own route rather than a field on `/api/snapshot`, for the reason the task
 * panel has one: this list changes on a different rhythm from the timeline — an
 * agent blocks, the owner answers, both within seconds — and a banner refetching
 * on every `request.created` must not drag a page of updates along with it.
 *
 * **Every pending request, never a page.** Design §7 requires several
 * outstanding requests to queue rather than overwrite one another, and a page
 * size would be exactly the bug that loses one: an agent stopped dead waiting on
 * its owner must not fall off the end of a list. The domain's own cap
 * (`PENDING_REQUEST_LIMIT`, 200) is the only bound, and it is far above the tens
 * of agents this product is sized for (design §1).
 *
 * Like every snapshot it is stamped with the stream cursor it is good to, by the
 * shared handler in `./snapshot.ts`.
 */
import { context, listPendingRequests, type DomainContext } from '$domain';

/**
 * The domain's own shape, named without importing `$db`.
 *
 * Recovered from the function's signature rather than re-declared, so the wire
 * format cannot drift from what the domain actually returns.
 */
export type SnapshotRequests = ReturnType<typeof listPendingRequests>;

/** Everything the banner renders, longest-blocked agent first. */
export type RequestsSnapshot = { requests: SnapshotRequests };

/** What is waiting on the owner right now. */
export function readRequestsSnapshot(ctx: DomainContext = context()): RequestsSnapshot {
	return { requests: listPendingRequests(ctx) };
}
