/**
 * `DELETE /api/messages/[id]` (migration 017).
 *
 * The owner deletes a message — their own post, their reply, or an agent's line
 * in a thread they are reading. Soft, so every browser that has already
 * rendered it can be told to drop it; the confirmation happens in the UI,
 * before the request is ever sent. The work is in `$http/owner`.
 */
import { deleteMessageHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const remove = deleteMessageHandler();

export const DELETE: RequestHandler = (event) => remove(event);
