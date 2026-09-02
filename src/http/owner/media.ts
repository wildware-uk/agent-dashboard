/**
 * `POST /api/media` — the owner uploads an image (migration 016).
 *
 * The counterpart to `create_upload`, and deliberately a different shape. An
 * agent is somewhere else and MCP cannot carry bytes, so it asks for a
 * single-use URL and PUTs to it: the token is what authorises a request that has
 * no session. The owner's browser puts the bytes on a request that already
 * carries their session cookie, so a token would be a round trip authorising
 * what is already authorised — and `upload_tokens.agent_id` has nobody to fill
 * it in.
 *
 * One request, then: the bytes in the body, the type in `Content-Type`, the name
 * in `?filename=`. Everything after that is the same pipeline as an agent's —
 * same allowlist, same per-kind cap, same sniffing, same place on disk — because
 * a second pipeline would be a second answer to "is this really a PNG", and one
 * of them would be wrong.
 *
 * The answer is the media row. It is not attached to anything yet: the browser
 * holds the id and sends it with the message, exactly as an agent holds one
 * between `create_upload` and `post_message`.
 */
import { uploadOwnerMedia } from '$domain';
import { ownerAction, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/** The query parameter carrying what the file is called. */
export const FILENAME_PARAM = 'filename';

export function uploadMediaHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const url = new URL(event.request.url);
		const declared = event.request.headers.get('content-length');

		const media = await uploadOwnerMedia(ctx, {
			// A label only, exactly as it is for an agent: it is not stored and it
			// names nothing on the server.
			filename: url.searchParams.get(FILENAME_PARAM) ?? 'upload',
			mime: event.request.headers.get('content-type') ?? '',
			body: event.request.body,
			// A claim, never the cap. The stream is where the size is enforced.
			contentLength: declared === null ? null : Number(declared)
		});

		return { status: 201, body: { media } };
	});
}
