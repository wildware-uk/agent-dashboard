/**
 * `GET /s/[token]/media/[id]/[variant]` — media on a shared card (design §7, §8).
 *
 * The same handler the owner's media route mounts, with one thing swapped: who
 * is allowed. Instead of the session, the question is "does this share cover
 * this media id", which `$domain` answers from the shared update's own
 * attachments — so a token cannot be steered at a screenshot on somebody else's
 * card by editing the URL.
 *
 * Reusing the handler rather than writing a second one is deliberate: the
 * sniffed content type, the immutable cache, the range handling and the
 * hardening headers are the security of this response, and a copy of them is a
 * copy that drifts.
 */
import { loadConfig } from '$config';
import { context, shareGrantsMedia } from '$domain';
import { createMediaHandler } from '$http/media';
import type { RequestHandler } from './$types';

const media = createMediaHandler({
	authorise: (event) =>
		shareGrantsMedia(context(), {
			token: (event.params as { token?: string }).token ?? '',
			mediaId: event.params.id ?? '',
			secret: loadConfig(process.env).TOKEN_SECRET
		})
});

export const GET: RequestHandler = (event) => media(event);
