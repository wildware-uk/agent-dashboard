/**
 * `PATCH|DELETE /api/tags/[id]` (migration 039).
 *
 * Rename a word, or retire it — both of which move it on every card carrying
 * it. The work is in `$http/owner`.
 */
import { renameTagHandler, retireTagHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const rename = renameTagHandler();
const retire = retireTagHandler();

export const PATCH: RequestHandler = (event) => rename(event);
export const DELETE: RequestHandler = (event) => retire(event);
