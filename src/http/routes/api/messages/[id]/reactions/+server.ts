/**
 * `POST /api/messages/[id]/reactions` (migration 024).
 *
 * The owner reacts to a message, or takes a reaction back. Toggling by default,
 * because that is what clicking one means. The work is in `$http/owner`.
 */
import { reactHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const react = reactHandler();

export const POST: RequestHandler = (event) => react(event);
