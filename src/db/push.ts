/**
 * The `push_subscriptions` repository (design §7).
 *
 * Plain statements over one table, like every other module here: no business
 * rules, no event publishing, and nothing that reaches for a clock it was not
 * given. Which of these rows is worth sending to, and what a failure means, is
 * `src/domain/push.ts`'s decision.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { jsonOf, jsonText, orNull } from './rows';

/** One browser that has agreed to be notified. The endpoint is its identity. */
export type PushSubscription = {
	id: string;
	/** Insertion order, like every other table (design §3). */
	seq: number;
	/** The push service's opaque delivery URL. Unique: one browser, one row. */
	endpoint: string;
	/** The subscription's public key, base64url, as the browser produced it. */
	p256dh: string;
	/** The subscription's auth secret, base64url, as the browser produced it. */
	auth: string;
	/** What the browser called itself, for an owner deciding which one to revoke. */
	label: string | null;
	createdAt: number;
	/** When a notification last reached it, or `null` if none ever has. */
	lastSentAt: number | null;
	/** Consecutive transient failures. Reset by a delivery that works. */
	failures: number;
	/**
	 * What this one device wants to be told about (design §7).
	 *
	 * `null` means the default, which is what every subscription made before
	 * migration 007 has: requests, and nothing else.
	 */
	prefs: PushPrefs | null;
};

/**
 * One device's notification filter.
 *
 * Three independent axes, because an owner's real rule is a sentence with three
 * clauses in it: "on my phone, only questions and errors, and only if they are
 * high priority". Each list is a whitelist; `$domain` decides what the members
 * may be and what an omitted list means.
 */
export type PushPrefs = {
	/** Event kinds: `request`, `update`, `message`. */
	types?: string[];
	/** For updates: which levels are worth a notification. */
	levels?: string[];
	/** For updates: which priorities are. */
	priorities?: string[];
};

type Row = {
	id: string;
	seq: number;
	endpoint: string;
	p256dh: string;
	auth: string;
	label: string | null;
	created_at: number;
	last_sent_at: number | null;
	failures: number;
	prefs: string | null;
};

const COLUMNS = 'seq, id, endpoint, p256dh, auth, label, created_at, last_sent_at, failures, prefs';

function toSubscription(row: Row): PushSubscription {
	return {
		id: row.id,
		seq: row.seq,
		endpoint: row.endpoint,
		p256dh: row.p256dh,
		auth: row.auth,
		label: row.label,
		createdAt: row.created_at,
		lastSentAt: row.last_sent_at,
		failures: row.failures,
		prefs: jsonOf<PushPrefs>(row.prefs)
	};
}

export type NewPushSubscription = {
	id?: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	label?: string | null;
	createdAt?: number;
	/** Omit to leave whatever this device already chose; see the upsert below. */
	prefs?: PushPrefs | null;
};

/**
 * Store a subscription, or refresh the one already on this endpoint.
 *
 * An upsert rather than an insert because a browser re-subscribing to the same
 * keypair is handed back the same endpoint: a second row would be a second copy
 * of one phone, and every notification would arrive twice. The keys are
 * refreshed on conflict (a browser may rotate them), `created_at` is kept (this
 * is the same subscription, not a new one), and `failures` is cleared — a
 * browser that has just asked to be subscribed is by definition reachable.
 */
export function upsertPushSubscription(db: Db, input: NewPushSubscription): PushSubscription {
	const row = {
		id: input.id ?? newId(),
		endpoint: input.endpoint,
		p256dh: input.p256dh,
		auth: input.auth,
		label: orNull(input.label),
		created_at: input.createdAt ?? Date.now(),
		prefs: input.prefs === undefined ? null : jsonText(input.prefs)
	};

	const saved = db
		.prepare<typeof row, Row>(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at, prefs)
			 VALUES (:id, :endpoint, :p256dh, :auth, :label, :created_at, :prefs)
			 ON CONFLICT (endpoint) DO UPDATE SET
				 p256dh = excluded.p256dh,
				 auth = excluded.auth,
				 label = excluded.label,
				 failures = 0,
				 -- Only when the caller said something. A browser re-subscribing on
				 -- every load passes no preferences, and must not wipe the ones the
				 -- owner set on this device.
				 prefs = CASE WHEN :prefs IS NULL THEN prefs ELSE :prefs END
			 RETURNING ${COLUMNS}`
		)
		.get(row);

	// The statement either inserts or updates, so it always returns a row.
	return toSubscription(saved!);
}

/** Every subscription, oldest first. There is one owner, so this is all of them. */
export function listPushSubscriptions(db: Db): PushSubscription[] {
	return db
		.prepare<[], Row>(`SELECT ${COLUMNS} FROM push_subscriptions ORDER BY created_at`)
		.all()
		.map(toSubscription);
}

export function findPushSubscription(db: Db, endpoint: string): PushSubscription | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM push_subscriptions WHERE endpoint = ?`)
		.get(endpoint);
	return row && toSubscription(row);
}

/** @returns whether a row was actually removed, so a caller can be idempotent. */
export function deletePushSubscription(db: Db, endpoint: string): boolean {
	return (
		db.prepare<[string]>(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint)
			.changes > 0
	);
}

/** A delivery worked: stamp it and forget any run of failures before it. */
export function markPushSent(db: Db, endpoint: string, at: number = Date.now()): void {
	db.prepare<[number, string]>(
		`UPDATE push_subscriptions SET last_sent_at = ?, failures = 0 WHERE endpoint = ?`
	).run(at, endpoint);
}

/**
 * A delivery failed in a way that might not be permanent.
 *
 * @returns the new consecutive-failure count, which is what the caller uses to
 *   decide that a subscription has stopped being worth trying.
 */
export function markPushFailed(db: Db, endpoint: string): number {
	const row = db
		.prepare<[string], { failures: number }>(
			`UPDATE push_subscriptions SET failures = failures + 1
			 WHERE endpoint = ? RETURNING failures`
		)
		.get(endpoint);
	return row?.failures ?? 0;
}

export function countPushSubscriptions(db: Db): number {
	const row = db
		.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM push_subscriptions`)
		.get();
	return row?.count ?? 0;
}

/** Replace one device's preferences. `null` restores the default. */
export function setPushPrefs(db: Db, endpoint: string, prefs: PushPrefs | null): boolean {
	return (
		db
			.prepare<[string | null, string]>(
				`UPDATE push_subscriptions SET prefs = ? WHERE endpoint = ?`
			)
			.run(jsonText(prefs), endpoint).changes > 0
	);
}
