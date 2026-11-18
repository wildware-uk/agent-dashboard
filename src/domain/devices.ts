/**
 * The owner's phones: a long-lived owner key per install, plus its push tokens.
 *
 * A device key stands in for the session cookie on a client that cannot keep
 * one. It is minted the way an agent token is — 256 random bits, stored only as
 * an HMAC under `TOKEN_SECRET`, compared in constant time — and revoking a
 * device deletes its row, so the next request with that key is refused.
 *
 * Nothing here publishes: no browser renders devices live, and the push senders
 * read the rows when they need them.
 */
import { randomBytes } from 'node:crypto';
import {
	clearOwnerDeviceToken,
	deleteOwnerDevice,
	findOwnerDeviceById,
	findOwnerDeviceByTokenHash,
	findProjectById,
	findProjectBySlug,
	insertOwnerDevice,
	listOwnerDevices as listOwnerDeviceRows,
	setOwnerDeviceAlertPrefs,
	setOwnerDeviceAlertProjects,
	setOwnerDeviceApns,
	setOwnerDeviceLiveActivity,
	touchOwnerDevice,
	type ApnsEnvironment,
	type OwnerDevice,
	type OwnerDeviceTokenColumn,
	type PushPrefs
} from '$db';
import { constantTimeEquals, hashAgentToken, isTokenShaped, TOKEN_BYTES } from './agents';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { assertPushPrefs } from './push';
import { requiredText } from './text';

export type { ApnsEnvironment, OwnerDevice };

export const DEVICE_NAME_MAX_LENGTH = 100;

/** How stale `last_seen_at` may get before a request writes it again. */
export const DEVICE_SEEN_RESOLUTION_MS = 60_000;

/** Apple tokens are bytes; the app sends them hex encoded. */
const HEX_TOKEN = /^[0-9a-f]+$/i;
const PUSH_TOKEN_MAX_LENGTH = 512;

/** Far more projects than one owner has; a bound on the body, not a product limit. */
export const ALERT_PROJECTS_MAX = 200;

export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ['sandbox', 'production'];

export type MintedDevice = { device: OwnerDevice; token: string };

/** A device's name, trimmed, or `invalid_argument`. */
export function deviceName(value: string): string {
	return requiredText(value, 'name', DEVICE_NAME_MAX_LENGTH);
}

export function mintOwnerDevice(
	ctx: DomainContext,
	input: { name: string; secret: string }
): MintedDevice {
	const name = deviceName(input.name);
	const token = randomBytes(TOKEN_BYTES).toString('base64url');
	const device = insertOwnerDevice(ctx.db, {
		name,
		tokenHash: hashAgentToken(token, input.secret),
		createdAt: ctx.now()
	});
	return { device, token };
}

/**
 * The device holding this key, or `null`.
 *
 * Notes the device as seen, at most once per {@link DEVICE_SEEN_RESOLUTION_MS},
 * so a phone polling every few seconds is not a write per request.
 */
export function authenticateOwnerDevice(
	ctx: DomainContext,
	input: { token: string | null | undefined; secret: string }
): OwnerDevice | null {
	const token = input.token?.trim() ?? '';
	if (!isTokenShaped(token) || input.secret === '') return null;

	const tokenHash = hashAgentToken(token, input.secret);
	const device = findOwnerDeviceByTokenHash(ctx.db, tokenHash);
	if (!device || !constantTimeEquals(device.tokenHash, tokenHash)) return null;

	const now = ctx.now();
	if (touchOwnerDevice(ctx.db, device.id, now, now - DEVICE_SEEN_RESOLUTION_MS)) {
		return { ...device, lastSeenAt: now };
	}
	return device;
}

export function listOwnerDevices(ctx: DomainContext): OwnerDevice[] {
	return listOwnerDeviceRows(ctx.db);
}

/** Revoke a device. Idempotent: `false` when there was nothing to remove. */
export function revokeOwnerDevice(ctx: DomainContext, deviceId: string): boolean {
	return deleteOwnerDevice(ctx.db, deviceId);
}

function pushToken(value: unknown, field: string): string {
	if (typeof value !== 'string') throw invalid(`${field} must be a string`);
	const token = value.trim();
	if (token === '' || token.length > PUSH_TOKEN_MAX_LENGTH || !HEX_TOKEN.test(token)) {
		throw invalid(`${field} must be a hex string`);
	}
	return token.toLowerCase();
}

function nullablePushToken(value: unknown, field: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	return pushToken(value, field);
}

/** Store the phone's alert token, and which Apple server it belongs to. */
export function setDeviceApnsToken(
	ctx: DomainContext,
	deviceId: string,
	input: { token: unknown; environment: unknown }
): void {
	const token = pushToken(input.token, 'token');
	if (!APNS_ENVIRONMENTS.includes(input.environment as ApnsEnvironment)) {
		throw invalid('environment must be sandbox or production');
	}
	if (!setOwnerDeviceApns(ctx.db, deviceId, token, input.environment as ApnsEnvironment)) {
		throw notFound(`no such device: ${deviceId}`);
	}
}

/** Store or clear the Live Activity tokens. An omitted one is left alone. */
export function setDeviceLiveActivityTokens(
	ctx: DomainContext,
	deviceId: string,
	input: { updateToken?: unknown; pushToStartToken?: unknown }
): void {
	const updateToken = nullablePushToken(input.updateToken, 'updateToken');
	const pushToStartToken = nullablePushToken(input.pushToStartToken, 'pushToStartToken');
	if (!setOwnerDeviceLiveActivity(ctx.db, deviceId, { updateToken, pushToStartToken })) {
		throw notFound(`no such device: ${deviceId}`);
	}
}

/**
 * Which projects this phone wants alerts about, by slug; `null` for all of them.
 *
 * Stored as ids, so a renamed project stays on the list. A slug that matches
 * nothing is refused by name, so the app learns its project list is stale.
 */
export function setDeviceAlertProjects(
	ctx: DomainContext,
	deviceId: string,
	projects: unknown
): void {
	let ids: string[] | null = null;
	if (projects !== null) {
		if (!Array.isArray(projects) || !projects.every((slug) => typeof slug === 'string')) {
			throw invalid('projects must be an array of project slugs, or null');
		}
		if (projects.length > ALERT_PROJECTS_MAX) {
			throw invalid(`projects must name at most ${ALERT_PROJECTS_MAX}`);
		}
		const slugs = [...new Set(projects.map((slug: string) => slug.trim().toLowerCase()))];
		const found = slugs.map((slug) => findProjectBySlug(ctx.db, slug));
		const unknown = slugs.filter((_slug, index) => !found[index]);
		if (unknown.length > 0) throw invalid(`unknown projects: ${unknown.join(', ')}`);
		ids = found.map((project) => project!.id);
	}
	if (!setOwnerDeviceAlertProjects(ctx.db, deviceId, ids)) {
		throw notFound(`no such device: ${deviceId}`);
	}
}

/**
 * Which alerts this phone wants: kinds (`request`, `message`, `comment`,
 * `update`), update levels and priorities. `null` restores every alert. Checked
 * the way a browser's preferences are, so an unknown word is refused rather
 * than quietly widening what the phone is woken for.
 */
export function setDeviceAlertPrefs(
	ctx: DomainContext,
	deviceId: string,
	prefs: unknown
): PushPrefs | null {
	const checked = assertPushPrefs(prefs);
	if (!setOwnerDeviceAlertPrefs(ctx.db, deviceId, checked)) {
		throw notFound(`no such device: ${deviceId}`);
	}
	return checked;
}

/** The slugs a device's alerts are limited to, or `null` for every project. */
export function deviceAlertProjects(ctx: DomainContext, device: OwnerDevice): string[] | null {
	if (device.alertProjectIds === null) return null;
	return device.alertProjectIds.flatMap((id) => findProjectById(ctx.db, id)?.slug ?? []);
}

/** Whether a phone wants an alert about this project. One about no project always goes. */
export function deviceWantsAlert(device: OwnerDevice, projectId: string | null): boolean {
	return (
		projectId === null ||
		device.alertProjectIds === null ||
		device.alertProjectIds.includes(projectId)
	);
}

/** Forget a token Apple said is dead, unless the phone has replaced it since. */
export function forgetDeviceToken(
	ctx: DomainContext,
	deviceId: string,
	column: OwnerDeviceTokenColumn,
	token: string
): boolean {
	return clearOwnerDeviceToken(ctx.db, deviceId, column, token);
}

export function findOwnerDevice(ctx: DomainContext, deviceId: string): OwnerDevice | undefined {
	return findOwnerDeviceById(ctx.db, deviceId);
}
