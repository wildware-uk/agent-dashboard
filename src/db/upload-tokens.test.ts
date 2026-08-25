import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertAgent } from './agents';
import { insertMedia } from './media';
import {
	consumeUploadToken,
	deleteExpiredUploadTokens,
	findUploadTokenById,
	insertUploadToken
} from './upload-tokens';

let db: Db;
let agentId: string;
let mediaId: string;
beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
	mediaId = insertMedia(db, {
		agentId,
		kind: 'image',
		mime: 'image/png',
		bytes: 10,
		sha256: 'abc'
	}).id;
});

const mint = (over: Partial<Parameters<typeof insertUploadToken>[1]> = {}) =>
	insertUploadToken(db, {
		agentId,
		mediaId,
		maxBytes: 1000,
		mimeAllow: ['image/png', 'image/jpeg'],
		expiresAt: 5000,
		...over
	});

describe('insertUploadToken', () => {
	it('round-trips the mime allowlist as a list', () => {
		const token = mint();

		expect(token).toMatchObject({
			agentId,
			mediaId,
			maxBytes: 1000,
			mimeAllow: ['image/png', 'image/jpeg'],
			expiresAt: 5000,
			usedAt: null
		});
		expect(findUploadTokenById(db, token.id)!.mimeAllow).toEqual(['image/png', 'image/jpeg']);
	});
});

describe('consumeUploadToken', () => {
	it('spends an unused, unexpired token exactly once', () => {
		const token = mint();

		const spent = consumeUploadToken(db, token.id, { now: 1000 });

		expect(spent).toMatchObject({ id: token.id, usedAt: 1000 });
		expect(consumeUploadToken(db, token.id, { now: 1001 })).toBeUndefined();
	});

	it('refuses an expired token', () => {
		const token = mint({ expiresAt: 100 });

		expect(consumeUploadToken(db, token.id, { now: 101 })).toBeUndefined();
		expect(findUploadTokenById(db, token.id)).toMatchObject({ usedAt: null });
	});

	it('refuses a token that was never minted', () => {
		expect(consumeUploadToken(db, 'nope', { now: 1 })).toBeUndefined();
	});
});

describe('deleteExpiredUploadTokens', () => {
	it('clears out unused tokens past their expiry', () => {
		const stale = mint({ expiresAt: 100 });
		const live = mint({ expiresAt: 9000 });

		expect(deleteExpiredUploadTokens(db, 1000)).toBe(1);
		expect(findUploadTokenById(db, stale.id)).toBeUndefined();
		expect(findUploadTokenById(db, live.id)).toBeDefined();
	});

	it('keeps spent tokens, which are the audit trail of an upload', () => {
		const token = mint({ expiresAt: 100 });
		consumeUploadToken(db, token.id, { now: 50 });

		expect(deleteExpiredUploadTokens(db, 1000)).toBe(0);
		expect(findUploadTokenById(db, token.id)).toBeDefined();
	});
});
