/**
 * Public share links for one update (design §7, §8).
 *
 * This is the only hole in a single-owner deployment's front door, so the shape
 * of it is the security argument:
 *
 * - **A share is a row, not a flag on the update.** Revoking is then a write
 *   that leaves evidence — when it was shared, when it stopped — rather than a
 *   boolean flipping back with nothing to say it was ever on.
 * - **`token_hash`, never the token.** Same rule as `agents.token_hash` (§8): a
 *   database that leaks must not hand over working capabilities. The consequence
 *   is deliberate and worth stating — the owner cannot be shown the link again
 *   later, so re-sharing mints a new one and retires the old.
 * - **One live share per update**, enforced by a partial unique index rather
 *   than by the domain remembering to check. Two live links on one card would be
 *   two things to revoke and one of them would be forgotten.
 * - **`views` and `last_viewed_at`** exist so the owner can see that a link is
 *   being used, which is the whole basis for deciding to revoke it.
 *
 * `update_id` has no foreign key for the same reason nothing else here does:
 * updates are soft-deleted, and the domain refuses to serve a share whose update
 * has gone rather than relying on a cascade that would erase the record of it
 * having been shared.
 */
export const sql = `
CREATE TABLE update_shares (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL,
	update_id TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER,
	views INTEGER NOT NULL DEFAULT 0,
	last_viewed_at INTEGER
) STRICT;

CREATE UNIQUE INDEX update_shares_id ON update_shares (id);

-- The lookup every public request makes, and unique because a token is a
-- capability: two rows answering to one token would be a bug nobody could see.
CREATE UNIQUE INDEX update_shares_token_hash ON update_shares (token_hash);

-- At most one live share per update. Partial, so a revoked share stays as a
-- record and does not block sharing that card again.
CREATE UNIQUE INDEX update_shares_live ON update_shares (update_id)
	WHERE revoked_at IS NULL;
`;
