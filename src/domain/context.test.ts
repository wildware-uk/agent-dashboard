import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase } from '$db';
import { freshDatabase } from '$db/testing';
import { EventBus, bus as sharedBus } from '$events';
import { context } from './context';

describe('context', () => {
	it('uses what the caller hands it', () => {
		const db = freshDatabase();
		const bus = new EventBus();
		const now = () => 1234;

		expect(context({ db, bus, now })).toEqual({ db, bus, now });
	});

	it('defaults the clock to the wall clock', () => {
		const before = Date.now();

		const { now } = context({ db: freshDatabase(), bus: new EventBus() });

		expect(now()).toBeGreaterThanOrEqual(before);
	});

	it('defaults the bus to the one process-wide instance', () => {
		expect(context({ db: freshDatabase() }).bus).toBe(sharedBus);
	});
});

describe('context with nothing to go on', () => {
	const saved = { ...process.env };
	let dir: string | undefined;

	afterEach(() => {
		closeDatabase();
		process.env = { ...saved };
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it('opens the process-wide database from the environment', () => {
		dir = mkdtempSync(join(tmpdir(), 'agent-dashboard-domain-'));
		process.env.DATA_DIR = dir;
		process.env.ADMIN_PASSWORD_HASH = `$argon2id$${'x'.repeat(40)}`;
		process.env.SESSION_SECRET = 's'.repeat(32);
		process.env.TOKEN_SECRET = 't'.repeat(32);

		const { db } = context();

		expect(db.open).toBe(true);
		expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 0 });
	});
});
