/**
 * `GET /api/agent/media/:id` — the bytes an agent cannot otherwise reach.
 *
 * The owner: "when attaching a file that's not an image, it does not get sent to
 * the agent properly … I sent a glb file, the agent cannot see it."
 *
 * They are right, and until now the answer was "that is by design". A tool
 * result is a context window: `get_messages` inlines a screenshot and a short
 * log, and anything bigger is named and skipped (`src/mcp/attachments.ts`),
 * because base64 of a five-megabyte model is five megabytes of nothing an agent
 * can read. But "too big to paste into a sentence" is not the same as "you may
 * not have it", and that is the conflation this route undoes: the agent fetches
 * it, with its own token, and writes it to disk where it is useful.
 *
 * ## Why this is not a hole in design §8
 *
 * `/media/:id/:variant` wants the owner's session and will keep wanting it — it
 * is the route a browser uses, and an agent's bearer token is deliberately not a
 * licence to walk the media tree. This route is narrower in three ways:
 *
 * - **A bearer token, checked exactly as `/mcp` checks one**, rate limit
 *   included. A revoked agent gets nothing.
 * - **Only media that is attached to something** — a message, a card, a
 *   question. The agent can already read those through `get_messages`, so this
 *   hands over nothing it was not already entitled to; an upload still being
 *   composed is attached to nothing and is refused.
 * - **Only the original, always as a download.** `openVariant` already emits
 *   `application/octet-stream` with `Content-Disposition: attachment` for a
 *   `file`, which is what keeps "any file" from meaning "any script on this
 *   origin" — and nothing an agent does with the bytes happens in a browser
 *   anyway.
 *
 * Everything else — the hardening headers, the ranges, the 404 for a row that
 * does not exist — is `./serve.ts`'s, reached through the `authorise` seam that
 * share links already use. There is no second copy of it here to drift.
 */
import { context, mediaIsAttached, type DomainContext } from '$domain';
import { authenticateMcpRequest, mcpConfig, createTokenRateLimiter } from '$mcp';
import type { TokenRateLimiter } from '$mcp';
import { createMediaHandler, type MediaHandler, type MediaRequestEvent } from './serve';
import type { MediaSettings } from '$media';

export type AgentMediaHandlerOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Media settings, injectable so tests need no environment. */
	settings?: () => MediaSettings | null;
	/** Token secret, injectable for the same reason. */
	config?: typeof mcpConfig;
	rateLimiter?: TokenRateLimiter;
};

export function createAgentMediaHandler(options: AgentMediaHandlerOptions = {}): MediaHandler {
	const {
		context: getContext = context,
		settings,
		config = mcpConfig,
		rateLimiter = createTokenRateLimiter()
	} = options;

	const authorise = (event: MediaRequestEvent): boolean => {
		const secrets = config();
		if (secrets === null) return false;

		const ctx = getContext();
		const auth = authenticateMcpRequest({
			request: event.request,
			ctx,
			secret: secrets.tokenSecret,
			rateLimiter
		});
		if (!auth.ok) return false;

		// Attached to something, or it is somebody's half-finished post rather
		// than an attachment anybody was sent.
		return mediaIsAttached(ctx, event.params.id ?? '');
	};

	return createMediaHandler({ context: getContext, settings, authorise });
}
