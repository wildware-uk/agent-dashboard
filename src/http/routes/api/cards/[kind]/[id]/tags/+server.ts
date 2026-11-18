/**
 * `POST /api/cards/[kind]/[id]/tags` (migration 039).
 *
 * One of the project's words, put on a card or taken off it. The work is in
 * `$http/owner`.
 */
import { tagCardHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const tag = tagCardHandler();

export const POST: RequestHandler = (event) => tag(event);
