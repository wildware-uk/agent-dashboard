/**
 * `POST /api/requests/[id]/answer` — the owner answers (design §5).
 *
 * The one door an answer comes through, and the reason it is a single door:
 * every value is checked against the request that asked for it before it reaches
 * the agent that will act on it. A browser is not a trustworthy client, so the
 * check is in `$domain` and this route cannot skip it.
 */
import { answerRequestHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const answer = answerRequestHandler();

export const POST: RequestHandler = (event) => answer(event);
