/**
 * `POST /api/updates/[id]/replies-seen` — the owner has read this thread.
 *
 * What lets a card leave "Recent replies" and drop back into its day. A route
 * of its own rather than a field on the update patch: that patch changes
 * `pinned` and refuses everything else on purpose, because an update is what an
 * agent reported and the owner curates it rather than editing it. Reading a
 * thread is neither.
 */
import { markRepliesSeenHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const seen = markRepliesSeenHandler();

export const POST: RequestHandler = (event) => seen(event);
