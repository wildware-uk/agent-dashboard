/**
 * Public share links: one card, readable by anyone holding the link (design §7, §8).
 *
 * ## This is the only unauthenticated read in the product
 *
 * Everything else in a single-owner deployment is behind the session cookie (§1,
 * §8). A share link is a deliberate hole in that, so the rules below are the
 * security argument rather than conveniences, and each one is a test in
 * `./shares.test.ts`.
 *
 * **The token is a capability, and it is the whole authorisation.** 32 random
 * bytes, so guessing is not a threat model; stored as an HMAC under
 * `TOKEN_SECRET` exactly as an agent token is, so a leaked database yields no
 * working links. The consequence is deliberate: the owner is shown the link once
 * and the server can never show it again. Re-sharing mints a new link and
 * retires the old one, which is also the only honest way to "rotate" a URL that
 * may already be in somebody's chat history.
 *
 * **A share grants one card and nothing else.** Not the thread on it — replies
 * are a conversation between the owner and their agents, and nobody clicked a
 * link expecting to publish those. Not the project's other updates, not the
 * project list, not who else is online. What a visitor gets is what the card
 * shows: its text, its level, when it was posted, who posted it, and its media.
 *
 * **Media is scoped to the share.** {@link shareGrantsMedia} answers whether one
 * media id belongs to the shared update, so a token cannot be pointed at
 * somebody else's screenshot by editing the URL. That check is what lets the
 * public media route reuse the ordinary one.
 *
 * **A deleted or revoked card is gone, and both look the same from outside.** A
 * visitor is told "not found" either way: distinguishing them would confirm that
 * a link once existed, which is information the holder of a dead link has no
 * business getting.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
	findAgentById,
	findLiveShareForUpdate,
	findProjectById,
	findShareByTokenHash,
	findUpdateById,
	insertUpdateShare,
	listMediaForUpdate,
	recordShareView,
	revokeSharesForUpdate,
	type Update,
	type UpdateShare
} from '$db';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { listUpdateMedia, type MediaAttachment } from './media';

/**
 * How much randomness a link carries.
 *
 * 256 bits, the same as an agent token. A share URL ends up in chat apps and
 * browser history, so the one property it must have is that possession is the
 * only way to hold it.
 */
export const SHARE_TOKEN_BYTES = 32;

/** The path a token is served under, so one module decides what a link looks like. */
export const SHARE_PATH_PREFIX = '/s';

/** The URL an owner copies. Absolute, because a link is for somewhere else. */
export function shareUrl(baseUrl: string, token: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${SHARE_PATH_PREFIX}/${token}`;
}

/**
 * The stored form of a token.
 *
 * Keyed HMAC rather than a bare hash, for the reason `hashAgentToken` is: the
 * token space is large but the hash of a *guessed* token is offline-checkable
 * without the key, and the key is not in the database.
 */
export function hashShareToken(token: string, secret: string): string {
	return createHmac('sha256', secret).update(`share:${token}`, 'utf8').digest('hex');
}

export type MintedShare = { share: UpdateShare; token: string };

export type ShareUpdateInput = {
	updateId: string;
	/** `TOKEN_SECRET`. Passed in, never read from the environment here. */
	secret: string;
};

/**
 * Make one card public, replacing any link it already had.
 *
 * Re-sharing revokes first rather than refusing, because the owner asking again
 * means they want a link they can copy — and the only way to give them one is a
 * new token. The old URL stops working at that moment, which is the honest
 * outcome and the only way to un-share something already pasted somewhere.
 *
 * @throws {DomainError} `not_found` for an unknown or deleted update.
 */
export function shareUpdate(ctx: DomainContext, input: ShareUpdateInput): MintedShare {
	const update = findUpdateById(ctx.db, input.updateId);
	if (!update || update.deletedAt !== null) {
		throw notFound(`no such update: ${input.updateId}`);
	}
	if (!input.secret) throw invalid('a share needs the deployment secret');

	const at = ctx.now();
	revokeSharesForUpdate(ctx.db, update.id, at);

	const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
	const share = insertUpdateShare(ctx.db, {
		updateId: update.id,
		tokenHash: hashShareToken(token, input.secret),
		createdAt: at
	});

	// The same event a pin publishes: every open tab refetches the row and sees
	// that this card is now public. The token is not on the bus and never could
	// be — an event goes down every open stream (§4), and this one is a secret.
	announce(ctx, update);

	return { share, token };
}

/**
 * Switch off this card's link.
 *
 * @returns whether one was live, so calling it twice is a truthful `false`
 *   rather than an error.
 */
export function revokeUpdateShare(ctx: DomainContext, updateId: string): boolean {
	const revoked = revokeSharesForUpdate(ctx.db, updateId, ctx.now());
	// Quiet when nothing was live, for the same reason a pin is quiet when the
	// flag already says what was asked for: an event that changed nothing would
	// make every open tab refetch a timeline that cannot have moved.
	if (!revoked) return false;

	const update = findUpdateById(ctx.db, updateId);
	if (update) announce(ctx, update);

	return true;
}

/** Tell every open tab that this card's sharing changed. */
function announce(ctx: DomainContext, update: Update): void {
	ctx.bus.publish('update.updated', {
		updateId: update.id,
		projectId: update.projectId,
		pinned: update.pinned
	});
}

/**
 * Which of these cards are public, for the timeline the owner is looking at.
 *
 * One query per card, like {@link listUpdateMedia} beside it: at this product's
 * scale (§1) a page is fifty rows, and the alternative is an `IN (...)` built
 * from caller-supplied ids.
 *
 * The token is not in the result and could not be — only its HMAC is stored — so
 * this says *that* a card is shared and how often the link has been opened,
 * never what the link is.
 */
export function listUpdateShares(
	ctx: DomainContext,
	updateIds: readonly string[]
): Record<string, { views: number; sharedAt: number }> {
	const byUpdate: Record<string, { views: number; sharedAt: number }> = {};

	for (const updateId of updateIds) {
		const share = findLiveShareForUpdate(ctx.db, updateId);
		if (share) byUpdate[updateId] = { views: share.views, sharedAt: share.createdAt };
	}

	return byUpdate;
}

/** The live share on a card, for an owner deciding whether to revoke it. */
export function findUpdateShare(ctx: DomainContext, updateId: string): UpdateShare | null {
	return findLiveShareForUpdate(ctx.db, updateId) ?? null;
}

/**
 * What a visitor holding a link is shown.
 *
 * Deliberately not an `UpdateView`: this is a separate, smaller shape so that a
 * field added to the dashboard's card cannot silently start being published.
 * Anything new here is a decision somebody had to type.
 */
export type SharedCard = {
	update: {
		id: string;
		title: string | null;
		/** Markdown, authored by an agent, therefore untrusted (design §8). */
		body: string;
		level: Update['level'];
		createdAt: number;
		editedAt: number | null;
	};
	/** What to call the agent that posted it. Never its id. */
	agentName: string;
	/** The project's display name. Never its slug or id — those address things. */
	projectName: string | null;
	media: MediaAttachment[];
};

export type ReadShareInput = {
	token: string;
	/** `TOKEN_SECRET`. Passed in, never read from the environment here. */
	secret: string;
};

/**
 * Resolve a link to the card it publishes, and count the view.
 *
 * `null` for every failure — unknown token, revoked link, deleted update — so a
 * visitor cannot learn which of those happened.
 */
export function readShare(ctx: DomainContext, input: ReadShareInput): SharedCard | null {
	const share = liveShare(ctx, input);
	if (!share) return null;

	const update = findUpdateById(ctx.db, share.updateId);
	if (!update || update.deletedAt !== null) return null;

	const agent = findAgentById(ctx.db, update.agentId);
	const project = findProjectById(ctx.db, update.projectId);

	recordShareView(ctx.db, share.id, ctx.now());

	return {
		update: {
			id: update.id,
			title: update.title,
			body: update.body,
			level: update.level,
			createdAt: update.createdAt,
			editedAt: update.editedAt
		},
		// A name, or nothing. A ULID would be an identifier handed to the public
		// for no reason a reader could use.
		agentName: agent?.name ?? 'An agent',
		projectName: project?.name ?? null,
		media: listUpdateMedia(ctx, [update.id])[update.id] ?? []
	};
}

export type ShareMediaInput = ReadShareInput & { mediaId: string };

/**
 * Whether a link may serve one media item.
 *
 * The only question the public media route asks. It is answered from the shared
 * update's own attachments, so a token can never be steered at media belonging
 * to a different card.
 */
export function shareGrantsMedia(ctx: DomainContext, input: ShareMediaInput): boolean {
	const share = liveShare(ctx, input);
	if (!share) return false;

	const update = findUpdateById(ctx.db, share.updateId);
	if (!update || update.deletedAt !== null) return false;

	return listMediaForUpdate(ctx.db, update.id).some((media) => media.id === input.mediaId);
}

/** The live share a token names, or `null`. Never says which failure it was. */
function liveShare(ctx: DomainContext, input: ReadShareInput): UpdateShare | null {
	if (!input.token || !input.secret) return null;

	const tokenHash = hashShareToken(input.token, input.secret);
	const share = findShareByTokenHash(ctx.db, tokenHash);
	// The lookup was by hash, so this can only disagree on a collision — checked
	// anyway, in constant time, because this is the one comparison that decides
	// whether an unauthenticated request gets data.
	if (!share || !constantTimeEquals(share.tokenHash, tokenHash)) return null;
	if (share.revokedAt !== null) return null;

	return share;
}

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
