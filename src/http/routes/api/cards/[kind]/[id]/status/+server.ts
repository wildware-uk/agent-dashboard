/**
 * `POST /api/cards/[kind]/[id]/status` (migration 035).
 *
 * The owner marks a card as work, moves it along, or stops calling it work.
 * This is what the board was. The work is in `$http/owner`.
 */
import { setCardStatusHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const status = setCardStatusHandler();

export const POST: RequestHandler = (event) => status(event);
