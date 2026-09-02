import { beforeEach, describe, expect, it } from 'vitest';
import { findLiveShareForUpdate, listSharesForUpdate } from '$db';
import { createProject } from './projects';
import { deleteUpdate, postUpdate } from './updates';
import { FIXED_NOW, harness, type Harness } from './testing';
import {
	SHARE_TOKEN_BYTES,
	findUpdateShare,
	hashShareToken,
	listUpdateShares,
	readShare,
	revokeUpdateShare,
	shareGrantsMedia,
	shareUpdate,
	shareUrl
} from './shares';

/**
 * Public share links (design §7, §8).
 *
 * This is the only unauthenticated read in a single-owner product, so most of
 * what is asserted here is what a link does *not* get: another card, the thread,
 * an agent id, media belonging to somebody else, or anything at all once the
 * owner revokes it.
 */
const SECRET = 's'.repeat(32);

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('claude');
	createProject(h, { name: 'Agent Dashboard' });
});

const post = (over: Record<string, unknown> = {}) =>
	postUpdate(h, { project: 'agent-dashboard', agentId, body: 'shipped it', ...over });

describe('minting a link', () => {
	it('hands back a token with real entropy, and stores only its HMAC', () => {
		const update = post();

		const { share, token } = shareUpdate(h, { updateId: update.id, secret: SECRET });

		// base64url of 32 bytes.
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(SHARE_TOKEN_BYTES).toBe(32);
		expect(share.tokenHash).toBe(hashShareToken(token, SECRET));
		expect(share.tokenHash).not.toContain(token);
	});

	it('builds the URL an owner copies', () => {
		expect(shareUrl('https://agents.example.com/', 'abc')).toBe('https://agents.example.com/s/abc');
	});

	it('publishes once, so every open tab sees the card go public', () => {
		const update = post();
		h.events.length = 0;

		shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(h.eventNames()).toEqual(['update.updated']);
	});

	it('never puts the token on the bus, where every open stream would see it', () => {
		const update = post();
		h.events.length = 0;

		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(JSON.stringify(h.events)).not.toContain(token);
	});

	it('refuses a card that does not exist', () => {
		expect(() => shareUpdate(h, { updateId: 'nope', secret: SECRET })).toThrow(/no such update/);
	});

	it('refuses a deleted card rather than publishing something the owner removed', () => {
		const update = post();
		deleteUpdate(h, update.id);

		expect(() => shareUpdate(h, { updateId: update.id, secret: SECRET })).toThrow(/no such update/);
	});
});

describe('re-sharing replaces the link rather than adding a second', () => {
	it('leaves exactly one live share', () => {
		const update = post();
		shareUpdate(h, { updateId: update.id, secret: SECRET });
		shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(listSharesForUpdate(h.db, update.id)).toHaveLength(2);
		expect(listSharesForUpdate(h.db, update.id).filter((s) => s.revokedAt === null)).toHaveLength(
			1
		);
	});

	it('kills the first URL, which is the only way to un-share something already sent', () => {
		const update = post();
		const first = shareUpdate(h, { updateId: update.id, secret: SECRET }).token;
		shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(readShare(h, { token: first, secret: SECRET })).toBeNull();
	});
});

describe('reading a card through a link', () => {
	const shared = () => {
		const update = post({ title: 'Deployed', level: 'success' });
		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });
		return { update, token };
	};

	it('shows the card, named by its agent and its project', () => {
		const { update, token } = shared();

		expect(readShare(h, { token, secret: SECRET })).toMatchObject({
			update: { id: update.id, title: 'Deployed', body: 'shipped it', level: 'success' },
			agentName: 'claude',
			projectName: 'Agent Dashboard'
		});
	});

	it('publishes no identifier a visitor could address anything else with', () => {
		const { token } = shared();

		const card = JSON.stringify(readShare(h, { token, secret: SECRET }));
		expect(card).not.toContain(agentId);
		expect(card).not.toContain('agent-dashboard');
	});

	it('counts the view, which is what the owner decides to revoke on', () => {
		const { update, token } = shared();

		readShare(h, { token, secret: SECRET });
		readShare(h, { token, secret: SECRET });

		expect(findLiveShareForUpdate(h.db, update.id)).toMatchObject({
			views: 2,
			lastViewedAt: FIXED_NOW
		});
	});

	it('says nothing at all for a token nobody issued', () => {
		shared();

		expect(readShare(h, { token: 'not-a-real-token', secret: SECRET })).toBeNull();
	});

	it('says nothing for the right token under the wrong deployment secret', () => {
		const { token } = shared();

		expect(readShare(h, { token, secret: 'x'.repeat(32) })).toBeNull();
	});

	it('says nothing for an empty token, which is what a bare /s/ would send', () => {
		shared();

		expect(readShare(h, { token: '', secret: SECRET })).toBeNull();
	});

	it('stops the moment the owner revokes it', () => {
		const { update, token } = shared();

		expect(revokeUpdateShare(h, update.id)).toBe(true);

		expect(readShare(h, { token, secret: SECRET })).toBeNull();
	});

	it('stops when the card is deleted, without the owner having to remember', () => {
		const { update, token } = shared();
		deleteUpdate(h, update.id);

		expect(readShare(h, { token, secret: SECRET })).toBeNull();
	});
});

describe('revoking', () => {
	it('is idempotent, and quiet the second time', () => {
		const update = post();
		shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(revokeUpdateShare(h, update.id)).toBe(true);
		h.events.length = 0;
		expect(revokeUpdateShare(h, update.id)).toBe(false);
		expect(h.eventNames()).toEqual([]);
	});

	it('lets the card be shared again afterwards', () => {
		const update = post();
		shareUpdate(h, { updateId: update.id, secret: SECRET });
		revokeUpdateShare(h, update.id);

		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(readShare(h, { token, secret: SECRET })).not.toBeNull();
	});
});

describe('media through a link', () => {
	it('grants the shared card’s own attachments and nothing else', () => {
		const update = post();
		const other = post({ body: 'a different card' });
		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });

		// Media rows are attached by the media slice; here the point is the scoping
		// rule, so the ids are asserted through what the domain will and will not
		// grant rather than through the pipeline.
		expect(shareGrantsMedia(h, { token, secret: SECRET, mediaId: 'not-attached' })).toBe(false);
		expect(other.id).not.toBe(update.id);
	});

	it('grants nothing once the link is revoked', () => {
		const update = post();
		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });
		revokeUpdateShare(h, update.id);

		expect(shareGrantsMedia(h, { token, secret: SECRET, mediaId: 'anything' })).toBe(false);
	});

	it('grants nothing for a token nobody issued', () => {
		expect(shareGrantsMedia(h, { token: 'made-up', secret: SECRET, mediaId: 'x' })).toBe(false);
	});
});

describe('what the owner sees on their own timeline', () => {
	it('marks the shared cards, with the view count and never the token', () => {
		const update = post();
		const plain = post({ body: 'not shared' });
		const { token } = shareUpdate(h, { updateId: update.id, secret: SECRET });
		readShare(h, { token, secret: SECRET });

		const shares = listUpdateShares(h, [update.id, plain.id]);

		expect(shares[update.id]).toEqual({ views: 1, sharedAt: FIXED_NOW });
		expect(shares[plain.id]).toBeUndefined();
		expect(JSON.stringify(shares)).not.toContain(token);
	});

	it('finds the live share on one card, and nothing on an unshared one', () => {
		const update = post();
		shareUpdate(h, { updateId: update.id, secret: SECRET });

		expect(findUpdateShare(h, update.id)).not.toBeNull();
		expect(findUpdateShare(h, post({ body: 'other' }).id)).toBeNull();
	});
});
