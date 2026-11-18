/**
 * `POST /api/cards/[kind]/[id]/pin` (migration 034).
 *
 * The owner keeps any card at the top of the feed — an update, one of their own
 * posts, a question, a task. The work is in `$http/owner`.
 */
import { pinCardHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const pin = pinCardHandler();

export const POST: RequestHandler = (event) => pin(event);
