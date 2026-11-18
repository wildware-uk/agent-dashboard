/**
 * `GET /api/agent/media/[id]` — an attachment, for the agent it was sent to.
 *
 * Always the original: there is one thing to fetch, and a variant in the path
 * would be a choice an agent has no reason to make. The work, and why this is
 * not a hole in design §8, is at `src/http/media/agent.ts`.
 */
import { createAgentMediaHandler } from '$http/media';
import type { RequestHandler } from './$types';

const media = createAgentMediaHandler();

export const GET: RequestHandler = (event) =>
	media({
		request: event.request,
		params: { id: event.params.id, variant: 'original' },
		cookies: event.cookies
	});
