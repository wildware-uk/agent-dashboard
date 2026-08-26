/**
 * `GET /api/messages` and `POST /api/messages` (design §7).
 *
 * The owner's reply box posts here, and a card's inline thread reads from here.
 * The write publishes `message.created`, so the thread appears in every open tab
 * — including the one that sent it — without a reload. The work is in
 * `$http/owner`.
 */
import { listMessagesHandler, postMessageHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const list = listMessagesHandler();
const post = postMessageHandler();

export const GET: RequestHandler = (event) => list(event);
export const POST: RequestHandler = (event) => post(event);
