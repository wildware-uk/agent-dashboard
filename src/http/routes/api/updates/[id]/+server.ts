/**
 * `PATCH /api/updates/[id]` and `DELETE /api/updates/[id]` (design §7).
 *
 * Pin an update, or soft-delete it. The delete is soft (§3) so every browser
 * that has already rendered the card can be told to drop it; the confirmation
 * the design asks for happens in the UI, before the request is ever sent.
 */
import { deleteUpdateHandler, patchUpdateHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const patch = patchUpdateHandler();
const remove = deleteUpdateHandler();

export const PATCH: RequestHandler = (event) => patch(event);
export const DELETE: RequestHandler = (event) => remove(event);
