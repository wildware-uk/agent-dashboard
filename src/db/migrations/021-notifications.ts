/**
 * Notifications the owner can read *in the app*.
 *
 * Until now a notification existed only as a push message: if the phone was
 * asleep, permission had never been granted, or the browser dropped it, the
 * thing that happened left no trace an owner could go back to. Their words:
 * "all notifications should be accessible from within the app, clicking a
 * notification should take me to the relevant message or reply."
 *
 * So the same events that send a push also write a row here, and the row is
 * what the app reads. Push becomes one delivery of a notification rather than
 * the notification itself — which is why the columns are the *target* rather
 * than the text of a message: what an owner wants from a notification an hour
 * later is not the sentence, it is the card it came from.
 *
 * `seen_at` is server-side for the same reason `projects.owner_seen_at` is
 * (migration 011): a bell that cleared on the desk and stayed lit on the phone
 * would be worse than one that never cleared.
 *
 * Only one of `update_id`, `message_id` and `request_id` is set, and the
 * nullable columns say which kind it is more honestly than a flag would — a
 * `kind` with no target would be a notification pointing at nothing.
 */
export const sql = `
CREATE TABLE notifications (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL CHECK (kind IN ('update', 'reply', 'request')),
	project_id TEXT REFERENCES projects (id),
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	request_id TEXT REFERENCES approvals (id),
	agent_id TEXT REFERENCES agents (id),
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	seen_at INTEGER
) STRICT;

-- The read the bell makes: newest first, and how many are still unseen.
CREATE INDEX notifications_seq ON notifications (seq DESC);
CREATE INDEX notifications_unseen ON notifications (seq DESC) WHERE seen_at IS NULL;
-- One notification per thing, so a replay or a double publish cannot double the
-- count. Partial, because only one target column is ever set.
CREATE UNIQUE INDEX notifications_update ON notifications (update_id) WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_message ON notifications (message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_request ON notifications (request_id) WHERE request_id IS NOT NULL;
`;
