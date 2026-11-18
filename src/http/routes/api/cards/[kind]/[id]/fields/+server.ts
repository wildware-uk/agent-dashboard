/**
 * `POST /api/cards/[kind]/[id]/fields` (migration 040).
 *
 * A note on a card — a branch name, a pull request link — set, corrected or
 * taken off. The work is in `$http/owner`.
 */
import { setCardFieldHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const field = setCardFieldHandler();

export const POST: RequestHandler = (event) => field(event);
