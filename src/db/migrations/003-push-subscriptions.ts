/**
 * Web Push subscriptions (design §7): where a notification is delivered when
 * an agent stops and the dashboard is not open.
 *
 * **The endpoint is the identity.** A push service hands the browser an opaque
 * URL, and re-subscribing the same browser to the same keypair returns the same
 * URL — so `endpoint` carries a unique index and a re-subscribe is an upsert
 * rather than a second row that would double every notification. The table still
 * keys on `seq` and carries a ULID `id` like every other one (design §3): the
 * endpoint is what identifies a *browser*, not what this table is ordered by.
 * There is no owner column for the same reason there is no user table (§1): one
 * deployment, one owner, and every subscription here is theirs.
 *
 * **The keys are stored as the browser gave them.** `p256dh` and `auth` are the
 * subscription's own encryption material, base64url as `PushSubscription.toJSON`
 * produces it, and they are only ever handed back to the push library. Nothing
 * derives anything from them, so nothing has to agree about their encoding.
 *
 * `label` is what the browser said it was — a trimmed user agent — so an owner
 * looking at two subscriptions can tell the phone from the laptop before
 * revoking one.
 *
 * `failures` is what makes the list self-cleaning without a sweeper: a push
 * service answering 404 or 410 means the subscription is dead and the sender
 * deletes it outright, and anything else transient is counted so a subscription
 * that never works again cannot be retried forever.
 */
export const sql = `
CREATE TABLE push_subscriptions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL,
	endpoint TEXT NOT NULL,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	label TEXT,
	created_at INTEGER NOT NULL,
	last_sent_at INTEGER,
	failures INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX push_subscriptions_id ON push_subscriptions (id);

-- The endpoint is what a re-subscribe collides on, which is what keeps one
-- browser one row (and one notification) however often it re-subscribes.
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);
`;
