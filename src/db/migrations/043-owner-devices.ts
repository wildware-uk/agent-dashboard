/**
 * The owner's phones (the iOS companion app).
 *
 * A phone cannot hold the session cookie the way a browser does, so each one is
 * given its own long-lived key, minted while the owner is signed in. Only the
 * HMAC of that key is stored, exactly as for agent tokens (design §8), and
 * removing the row is what revokes it.
 *
 * The Apple push tokens live on the same row because they belong to the same
 * install: the alert token, and the two Live Activity tokens. All three are
 * nullable — a phone that declined notifications is still a phone that can read
 * the dashboard.
 */
export const sql = `
CREATE TABLE owner_devices (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	apns_token TEXT,
	apns_environment TEXT CHECK (apns_environment IN ('sandbox', 'production')),
	live_activity_token TEXT,
	push_to_start_token TEXT,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER,
	failures INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX owner_devices_id ON owner_devices (id);
CREATE UNIQUE INDEX owner_devices_token_hash ON owner_devices (token_hash);
`;
