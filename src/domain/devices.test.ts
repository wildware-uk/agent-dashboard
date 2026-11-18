import { beforeEach, describe, expect, it } from 'vitest';
import { findOwnerDeviceById } from '$db';
import {
	authenticateOwnerDevice,
	DEVICE_SEEN_RESOLUTION_MS,
	forgetDeviceToken,
	listOwnerDevices,
	mintOwnerDevice,
	revokeOwnerDevice,
	setDeviceApnsToken,
	setDeviceLiveActivityTokens
} from './devices';
import { FIXED_NOW, harness, type Harness } from './testing';

const SECRET = 't'.repeat(32);
let clock = FIXED_NOW;
let h: Harness;

beforeEach(() => {
	clock = FIXED_NOW;
	h = harness({ now: () => clock });
});

const mint = (name = 'Alex’s iPhone') => mintOwnerDevice(h, { name, secret: SECRET });

describe('minting a device key', () => {
	it('returns the key once and stores only its HMAC', () => {
		const { device, token } = mint();

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(device.tokenHash).not.toContain(token);
		expect(device).toMatchObject({
			name: 'Alex’s iPhone',
			createdAt: FIXED_NOW,
			lastSeenAt: null
		});
	});

	it('refuses a blank or overlong name', () => {
		expect(() => mint('  ')).toThrow(/name is required/);
		expect(() => mint('x'.repeat(101))).toThrow(/name/);
	});
});

describe('authenticating a device key', () => {
	it('resolves the device that holds it', () => {
		const { device, token } = mint();

		expect(authenticateOwnerDevice(h, { token, secret: SECRET })?.id).toBe(device.id);
	});

	it('refuses an unknown, malformed or wrongly keyed token', () => {
		const { token } = mint();

		expect(authenticateOwnerDevice(h, { token: 'x'.repeat(43), secret: SECRET })).toBeNull();
		expect(authenticateOwnerDevice(h, { token: 'short', secret: SECRET })).toBeNull();
		expect(authenticateOwnerDevice(h, { token, secret: 'u'.repeat(32) })).toBeNull();
		expect(authenticateOwnerDevice(h, { token: null, secret: SECRET })).toBeNull();
	});

	it('stops working the moment the device is revoked', () => {
		const { device, token } = mint();

		expect(revokeOwnerDevice(h, device.id)).toBe(true);
		expect(authenticateOwnerDevice(h, { token, secret: SECRET })).toBeNull();
		expect(revokeOwnerDevice(h, device.id)).toBe(false);
	});

	it('notes the device as seen at most once a minute', () => {
		const { device, token } = mint();

		authenticateOwnerDevice(h, { token, secret: SECRET });
		expect(findOwnerDeviceById(h.db, device.id)?.lastSeenAt).toBe(FIXED_NOW);

		clock = FIXED_NOW + DEVICE_SEEN_RESOLUTION_MS - 1;
		authenticateOwnerDevice(h, { token, secret: SECRET });
		expect(findOwnerDeviceById(h.db, device.id)?.lastSeenAt).toBe(FIXED_NOW);

		clock = FIXED_NOW + DEVICE_SEEN_RESOLUTION_MS;
		authenticateOwnerDevice(h, { token, secret: SECRET });
		expect(findOwnerDeviceById(h.db, device.id)?.lastSeenAt).toBe(clock);
	});
});

describe('push tokens', () => {
	it('stores the alert token lowercased, with its environment', () => {
		const { device } = mint();

		setDeviceApnsToken(h, device.id, { token: 'ABCDEF0123', environment: 'sandbox' });

		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			apnsToken: 'abcdef0123',
			apnsEnvironment: 'sandbox'
		});
	});

	it('refuses a token that is not hex, or an unknown environment', () => {
		const { device } = mint();

		expect(() =>
			setDeviceApnsToken(h, device.id, { token: 'not hex!', environment: 'sandbox' })
		).toThrow(/hex/);
		expect(() =>
			setDeviceApnsToken(h, device.id, { token: 'abcd', environment: 'staging' })
		).toThrow(/environment/);
		expect(() => setDeviceApnsToken(h, device.id, { token: 42, environment: 'sandbox' })).toThrow(
			/string/
		);
	});

	it('leaves an omitted Live Activity token alone and clears a null one', () => {
		const { device } = mint();

		setDeviceLiveActivityTokens(h, device.id, { updateToken: 'aa', pushToStartToken: 'bb' });
		setDeviceLiveActivityTokens(h, device.id, { updateToken: 'cc' });
		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			liveActivityToken: 'cc',
			pushToStartToken: 'bb'
		});

		setDeviceLiveActivityTokens(h, device.id, { updateToken: null });
		expect(findOwnerDeviceById(h.db, device.id)).toMatchObject({
			liveActivityToken: null,
			pushToStartToken: 'bb'
		});
	});

	it('moves a token to the device that registers it last, so one phone signed in twice is pushed once', () => {
		const old = mint('old sign-in').device;
		const fresh = mint('new sign-in').device;
		setDeviceApnsToken(h, old.id, { token: 'aaaa', environment: 'sandbox' });
		setDeviceLiveActivityTokens(h, old.id, { updateToken: 'bbbb', pushToStartToken: 'cccc' });

		setDeviceApnsToken(h, fresh.id, { token: 'aaaa', environment: 'sandbox' });
		setDeviceLiveActivityTokens(h, fresh.id, { updateToken: 'bbbb', pushToStartToken: 'cccc' });

		expect(findOwnerDeviceById(h.db, old.id)).toMatchObject({
			apnsToken: null,
			liveActivityToken: null,
			pushToStartToken: null
		});
		expect(findOwnerDeviceById(h.db, fresh.id)).toMatchObject({
			apnsToken: 'aaaa',
			liveActivityToken: 'bbbb',
			pushToStartToken: 'cccc'
		});
	});

	it('answers not_found for a device that is gone', () => {
		expect(() =>
			setDeviceApnsToken(h, 'nope', { token: 'abcd', environment: 'production' })
		).toThrow(/no such device/);
	});

	it('forgets a dead token only if the phone has not replaced it', () => {
		const { device } = mint();
		setDeviceApnsToken(h, device.id, { token: 'aaaa', environment: 'production' });

		expect(forgetDeviceToken(h, device.id, 'apns_token', 'bbbb')).toBe(false);
		expect(findOwnerDeviceById(h.db, device.id)?.apnsToken).toBe('aaaa');
		expect(forgetDeviceToken(h, device.id, 'apns_token', 'aaaa')).toBe(true);
		expect(findOwnerDeviceById(h.db, device.id)?.apnsToken).toBeNull();
	});
});

it('lists every device, oldest first', () => {
	mint('one');
	mint('two');

	expect(listOwnerDevices(h).map((device) => device.name)).toEqual(['one', 'two']);
});
