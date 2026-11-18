/**
 * `owner_devices` (migration 043): the owner's phones.
 *
 * Holds the HMAC of each phone's key, never the key, and the Apple push tokens
 * that phone registered. Hashing, comparison and what a failure means are
 * `src/domain/devices.ts`'s business.
 */
import type { Db } from './connection';
import { newId } from './ids';

export type ApnsEnvironment = 'sandbox' | 'production';

export type OwnerDevice = {
	seq: number;
	id: string;
	name: string;
	/** HMAC-SHA256 of the device key under `TOKEN_SECRET`. Never the key. */
	tokenHash: string;
	apnsToken: string | null;
	apnsEnvironment: ApnsEnvironment | null;
	liveActivityToken: string | null;
	pushToStartToken: string | null;
	createdAt: number;
	lastSeenAt: number | null;
	/** Consecutive transient push failures. Reset by a delivery that works. */
	failures: number;
	/** Projects this phone wants alerts about (migration 045). `null` is every project. */
	alertProjectIds: string[] | null;
};

type Row = {
	seq: number;
	id: string;
	name: string;
	token_hash: string;
	apns_token: string | null;
	apns_environment: ApnsEnvironment | null;
	live_activity_token: string | null;
	push_to_start_token: string | null;
	created_at: number;
	last_seen_at: number | null;
	failures: number;
	alert_project_ids: string | null;
};

const COLUMNS = `seq, id, name, token_hash, apns_token, apns_environment, live_activity_token,
	push_to_start_token, created_at, last_seen_at, failures, alert_project_ids`;

function toDevice(row: Row): OwnerDevice {
	return {
		seq: row.seq,
		id: row.id,
		name: row.name,
		tokenHash: row.token_hash,
		apnsToken: row.apns_token,
		apnsEnvironment: row.apns_environment,
		liveActivityToken: row.live_activity_token,
		pushToStartToken: row.push_to_start_token,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		failures: row.failures,
		alertProjectIds:
			row.alert_project_ids === null ? null : (JSON.parse(row.alert_project_ids) as string[])
	};
}

export type NewOwnerDevice = {
	id?: string;
	name: string;
	tokenHash: string;
	createdAt?: number;
};

export function insertOwnerDevice(db: Db, input: NewOwnerDevice): OwnerDevice {
	const row = {
		id: input.id ?? newId(),
		name: input.name,
		token_hash: input.tokenHash,
		created_at: input.createdAt ?? Date.now()
	};

	return toDevice(
		db
			.prepare<typeof row, Row>(
				`INSERT INTO owner_devices (id, name, token_hash, created_at)
				 VALUES (:id, :name, :token_hash, :created_at)
				 RETURNING ${COLUMNS}`
			)
			.get(row)!
	);
}

export function findOwnerDeviceById(db: Db, id: string): OwnerDevice | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM owner_devices WHERE id = ?`)
		.get(id);
	return row && toDevice(row);
}

export function findOwnerDeviceByTokenHash(db: Db, tokenHash: string): OwnerDevice | undefined {
	const row = db
		.prepare<[string], Row>(`SELECT ${COLUMNS} FROM owner_devices WHERE token_hash = ?`)
		.get(tokenHash);
	return row && toDevice(row);
}

/** Every device, oldest first. */
export function listOwnerDevices(db: Db): OwnerDevice[] {
	return db
		.prepare<[], Row>(`SELECT ${COLUMNS} FROM owner_devices ORDER BY seq`)
		.all()
		.map(toDevice);
}

/** @returns whether a row was removed. */
export function deleteOwnerDevice(db: Db, id: string): boolean {
	return db.prepare(`DELETE FROM owner_devices WHERE id = ?`).run(id).changes === 1;
}

/**
 * Record that the device was used, unless it already was since `notBefore`.
 *
 * The condition is in the statement so a burst of requests writes once.
 */
export function touchOwnerDevice(db: Db, id: string, at: number, notBefore: number): boolean {
	return (
		db
			.prepare(
				`UPDATE owner_devices SET last_seen_at = ?
				 WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`
			)
			.run(at, id, notBefore).changes === 1
	);
}

/**
 * A push token names one app install, so it belongs to one device row. Signing the
 * same phone in again makes a new row; without this the old row keeps the tokens
 * and the phone gets every alert, and every Live Activity, twice.
 */
function releaseTokenElsewhere(
	db: Db,
	id: string,
	column: OwnerDeviceTokenColumn,
	token: string | null | undefined
): void {
	if (token == null) return;
	db.prepare(`UPDATE owner_devices SET ${column} = NULL WHERE ${column} = ? AND id != ?`).run(
		token,
		id
	);
}

export function setOwnerDeviceApns(
	db: Db,
	id: string,
	token: string,
	environment: ApnsEnvironment
): boolean {
	return db.transaction(() => {
		const updated =
			db
				.prepare(
					`UPDATE owner_devices SET apns_token = ?, apns_environment = ?, failures = 0 WHERE id = ?`
				)
				.run(token, environment, id).changes === 1;
		if (updated) releaseTokenElsewhere(db, id, 'apns_token', token);
		return updated;
	})();
}

/** `null` means alerts about every project. */
export function setOwnerDeviceAlertProjects(
	db: Db,
	id: string,
	projectIds: readonly string[] | null
): boolean {
	return (
		db
			.prepare(`UPDATE owner_devices SET alert_project_ids = ? WHERE id = ?`)
			.run(projectIds === null ? null : JSON.stringify(projectIds), id).changes === 1
	);
}

export type LiveActivityTokens = {
	/** `undefined` leaves the stored value alone; `null` clears it. */
	updateToken?: string | null;
	pushToStartToken?: string | null;
};

export function setOwnerDeviceLiveActivity(
	db: Db,
	id: string,
	tokens: LiveActivityTokens
): boolean {
	return db.transaction(() => {
		const updated =
			db
				.prepare<{
					id: string;
					update: 0 | 1;
					token: string | null;
					start: 0 | 1;
					p2s: string | null;
				}>(
					`UPDATE owner_devices SET
					live_activity_token = CASE WHEN :update = 1 THEN :token ELSE live_activity_token END,
					push_to_start_token = CASE WHEN :start = 1 THEN :p2s ELSE push_to_start_token END
				 WHERE id = :id`
				)
				.run({
					id,
					update: tokens.updateToken === undefined ? 0 : 1,
					token: tokens.updateToken ?? null,
					start: tokens.pushToStartToken === undefined ? 0 : 1,
					p2s: tokens.pushToStartToken ?? null
				}).changes === 1;
		if (updated) {
			releaseTokenElsewhere(db, id, 'live_activity_token', tokens.updateToken);
			releaseTokenElsewhere(db, id, 'push_to_start_token', tokens.pushToStartToken);
		}
		return updated;
	})();
}

export type OwnerDeviceTokenColumn = 'apns_token' | 'live_activity_token' | 'push_to_start_token';

/**
 * Forget a token Apple refused, but only if it is still the one refused.
 *
 * Matching on the value keeps a fresh token the phone registered while the
 * failing send was in flight.
 */
export function clearOwnerDeviceToken(
	db: Db,
	id: string,
	column: OwnerDeviceTokenColumn,
	token: string
): boolean {
	return (
		db
			.prepare(`UPDATE owner_devices SET ${column} = NULL WHERE id = ? AND ${column} = ?`)
			.run(id, token).changes === 1
	);
}

export function markOwnerDevicePushed(db: Db, id: string): void {
	db.prepare(`UPDATE owner_devices SET failures = 0 WHERE id = ?`).run(id);
}

/** @returns the failure count after this one. */
export function markOwnerDevicePushFailed(db: Db, id: string): number {
	const row = db
		.prepare<[string], { failures: number }>(
			`UPDATE owner_devices SET failures = failures + 1 WHERE id = ? RETURNING failures`
		)
		.get(id);
	return row?.failures ?? 0;
}
