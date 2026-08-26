/**
 * `DELETE /api/requests/[id]` — the owner dismisses a prompt (design §5, §7).
 *
 * A dismissal is not a rejection: `confirm` has one of those and it is an
 * answer. This says "I am not answering", the agent is told `cancelled`, and
 * whoever was parked on it stops waiting. The work is in `$http/owner`.
 */
import { dismissRequestHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const dismiss = dismissRequestHandler();

export const DELETE: RequestHandler = (event) => dismiss(event);
