import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import {
	countPushSubscriptions,
	deletePushSubscription,
	findPushSubscription,
	listPushSubscriptions,
	markPushFailed,
	markPushSent,
	upsertPushSubscription
} from './push';

let db: Db;
beforeEach(() => {
	db = freshDatabase();
});

const store = (over: Partial<Parameters<typeof upsertPushSubscription>[1]> = {}) =>
	upsertPushSubscription(db, {
		endpoint: 'https://push.example/one',
		p256dh: 'key-one',
		auth: 'auth-one',
		label: 'a phone',
		createdAt: 1000,
		...over
	});

describe('upsertPushSubscription', () => {
	it('stores a subscription as the browser gave it', () => {
		expect(store()).toMatchObject({
			endpoint: 'https://push.example/one',
			p256dh: 'key-one',
			auth: 'auth-one',
			label: 'a phone',
			createdAt: 1000,
			lastSentAt: null,
			failures: 0
		});
	});

	it('is one row per endpoint, so a re-subscribe is not a second phone', () => {
		store();
		store({ p256dh: 'rotated', auth: 'rotated-auth', label: 'the same phone', createdAt: 2000 });

		expect(countPushSubscriptions(db)).toBe(1);
		expect(findPushSubscription(db, 'https://push.example/one')).toMatchObject({
			p256dh: 'rotated',
			auth: 'rotated-auth',
			label: 'the same phone',
			// The subscription is the same one, so when it first appeared is unchanged.
			createdAt: 1000
		});
	});

	it('clears a run of failures, because a browser that just asked is reachable', () => {
		store();
		markPushFailed(db, 'https://push.example/one');
		markPushFailed(db, 'https://push.example/one');

		expect(store().failures).toBe(0);
	});

	it('keeps two different endpoints apart', () => {
		store();
		store({ endpoint: 'https://push.example/two', createdAt: 1500 });

		expect(listPushSubscriptions(db).map((row) => row.endpoint)).toEqual([
			'https://push.example/one',
			'https://push.example/two'
		]);
	});
});

describe('recording what a send did', () => {
	it('stamps a delivery and forgets the failures before it', () => {
		store();
		markPushFailed(db, 'https://push.example/one');
		markPushSent(db, 'https://push.example/one', 5000);

		expect(findPushSubscription(db, 'https://push.example/one')).toMatchObject({
			lastSentAt: 5000,
			failures: 0
		});
	});

	it('counts consecutive failures, which is what gives up on a dead endpoint', () => {
		store();

		expect(markPushFailed(db, 'https://push.example/one')).toBe(1);
		expect(markPushFailed(db, 'https://push.example/one')).toBe(2);
	});

	it('says nothing happened for an endpoint that is already gone', () => {
		expect(markPushFailed(db, 'https://push.example/missing')).toBe(0);
	});
});

describe('deletePushSubscription', () => {
	it('removes it and says so', () => {
		store();

		expect(deletePushSubscription(db, 'https://push.example/one')).toBe(true);
		expect(countPushSubscriptions(db)).toBe(0);
	});

	it('is safe to call twice', () => {
		store();
		deletePushSubscription(db, 'https://push.example/one');

		expect(deletePushSubscription(db, 'https://push.example/one')).toBe(false);
	});
});
