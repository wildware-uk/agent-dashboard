import { describe, expect, it } from 'vitest';
import * as db from './index';
import { TABLES } from './schema';

/**
 * `$db` is what every later slice imports, and `$db/testing` is what every later
 * test imports. Both surfaces are checked here so a re-export dropped during a
 * refactor fails this suite rather than someone else's.
 */
describe('the $db surface', () => {
	it('exposes the connection and the migration runner', () => {
		for (const name of [
			'openDatabase',
			'getDatabase',
			'closeDatabase',
			'databaseFile',
			'migrate',
			'appliedMigrations',
			'pendingMigrations'
		] as const) {
			expect(db[name], name).toBeTypeOf('function');
		}
	});

	it('exposes an id minter', () => {
		expect(db.newId()).toHaveLength(db.ID_LENGTH);
	});

	it('exposes a repository function for every table in the design', () => {
		const exported = Object.keys(db);
		const repositoryFor: Record<string, string> = {
			projects: 'insertProject',
			agents: 'insertAgent',
			sessions: 'insertSession',
			updates: 'insertUpdate',
			media: 'insertMedia',
			derivatives: 'insertDerivative',
			upload_tokens: 'insertUploadToken',
			tasks: 'insertTask',
			messages: 'insertMessage',
			read_cursors: 'advanceReadCursor',
			approvals: 'insertApproval'
		};

		for (const table of TABLES) {
			expect(exported, `${table} needs a repository`).toContain(repositoryFor[table]);
		}
	});

	it('keeps the test helper out of the production entry point', () => {
		expect(Object.keys(db)).not.toContain('freshDatabase');
	});

	it('is enough on its own to open a database and write a row', async () => {
		const { freshDatabase } = await import('./testing');
		const handle = freshDatabase();

		const project = db.insertProject(handle, { slug: 'p', name: 'P' });

		expect(db.findProjectBySlug(handle, 'p')).toEqual(project);
	});
});
