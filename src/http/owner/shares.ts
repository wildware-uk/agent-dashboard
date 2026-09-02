/**
 * The owner's share links (design §7, §8): publishing one card, and taking it
 * back.
 *
 * Two endpoints on one resource. The same rules as the rest of `../owner/` — the
 * domain does the work, the session is checked through the wrapper rather than
 * written again, a domain error becomes its status.
 *
 * **The URL is returned exactly once, by the call that mints it.** The database
 * keeps only an HMAC of the token (`src/domain/shares.ts`), so there is no
 * endpoint that can hand the link over again later and no way to add one without
 * storing a working capability in plaintext. Sharing again mints a new link and
 * retires the old, which is also the only truthful way to rotate a URL that may
 * already be in somebody's chat history.
 *
 * **`GET` is deliberately absent.** "Is this card shared, and how often has the
 * link been opened" travels on the update itself, in the timeline snapshot, so
 * the owner sees it on the card rather than by asking a second endpoint.
 */
import { revokeUpdateShare, shareUpdate, shareUrl } from '$domain';
import { loadConfig } from '$config';
import { ownerAction, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/** What a share needs from the deployment: the HMAC key, and the public origin. */
export type ShareSettings = () => { secret: string; baseUrl: string };

export type ShareHandlerOptions = OwnerHandlerOptions & { settings?: ShareSettings };

const environmentSettings: ShareSettings = () => {
	const config = loadConfig(process.env);
	return { secret: config.TOKEN_SECRET, baseUrl: config.PUBLIC_BASE_URL };
};

/**
 * `POST /api/updates/[id]/share` — publish this card, and hand back the link.
 *
 * 200 with `{ url, share }`. Calling it twice gives two different URLs and the
 * first stops working: a link the owner cannot be shown again is a link that has
 * to be replaced rather than recovered.
 */
export function shareUpdateHandler(options: ShareHandlerOptions = {}): OwnerHandler {
	const settings = options.settings ?? environmentSettings;
	return ownerAction(options, (event, ctx) => {
		const { secret, baseUrl } = settings();
		const { share, token } = shareUpdate(ctx, { updateId: event.params.id ?? '', secret });

		return Promise.resolve({
			status: 200,
			body: {
				// The one and only time this exists anywhere but the holder's browser.
				url: shareUrl(baseUrl, token),
				share: { id: share.id, update_id: share.updateId, created_at: share.createdAt }
			}
		});
	});
}

/**
 * `DELETE /api/updates/[id]/share` — stop the link working.
 *
 * `revoked` says whether one was live, so revoking twice is a truthful 200
 * rather than an error the owner has to interpret.
 */
export function revokeShareHandler(options: ShareHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) =>
		Promise.resolve({
			status: 200,
			body: { revoked: revokeUpdateShare(ctx, event.params.id ?? '') }
		})
	);
}
