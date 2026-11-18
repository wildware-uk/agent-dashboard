/**
 * `POST /api/cards/[kind]/[id]/reactions` (migration 034).
 *
 * The owner reacts to any card, or takes a reaction back. Toggling by default,
 * because that is what clicking one means. The work is in `$http/owner`.
 */
import { reactToCardHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const react = reactToCardHandler();

export const POST: RequestHandler = (event) => react(event);
