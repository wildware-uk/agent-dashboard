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
import {
	context,
	listPendingRequests,
	reactionsFor,
	type Reaction,
	listRequestEmbeds,
	listRequestMedia,
	type DomainContext,
	type EmbedView,
	type MediaAttachment
} from '$domain';

/**
 * The domain's own shape, named without importing `$db`, plus what the card
 * carries (migration 030).
 *
 * Recovered from the function's signature rather than re-declared, so the wire
 * format cannot drift from what the domain actually returns. `media` and
 * `embeds` are always arrays for the same reason an update's are: a card that
 * reads `media.length` should not have to guard.
 */
export type SnapshotRequest = ReturnType<typeof listPendingRequests>[number] & {
	media: MediaAttachment[];
	embeds: EmbedView[];
	/** The emoji on the question itself (migration 034). */
	reactions: Reaction[];
};

export type SnapshotRequests = SnapshotRequest[];

/** Everything the banner renders, longest-blocked agent first. */
export type RequestsSnapshot = { requests: SnapshotRequests };

/** What is waiting on the owner right now. */
export function readRequestsSnapshot(ctx: DomainContext = context()): RequestsSnapshot {
	// One read for the whole list, after the list is known — an approval's
	// attachments are a property of the rows that came back, exactly as a card's
	// are (`./snapshot.ts`).
	return {
		requests: listPendingRequests(ctx).map((request) => ({
			...request,
			media: listRequestMedia(ctx, request.id),
			embeds: listRequestEmbeds(ctx, request.id),
			reactions: reactionsFor(ctx, 'request', [request.id])
		}))
	};
}
