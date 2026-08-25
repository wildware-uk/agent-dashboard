import { describe, expect, it } from 'vitest';
import { appliedMigrations, pendingMigrations } from './migrate';
import { insertProject, listProjects } from './projects';
import { freshDatabase, withDatabase } from './testing';

describe('freshDatabase', () => {
	it('comes up with every migration applied', () => {
		const db = freshDatabase();

		expect(appliedMigrations(db).length).toBeGreaterThan(0);
		expect(pendingMigrations(db)).toEqual([]);
	});

	it('is empty of data', () => {
		expect(listProjects(freshDatabase())).toEqual([]);
	});

	it('is isolated: two databases never see each other`s rows', () => {
		const first = freshDatabase();
		const second = freshDatabase();

		insertProject(first, { slug: 'only-here', name: 'One' });

		expect(listProjects(first)).toHaveLength(1);
		expect(listProjects(second)).toHaveLength(0);
	});

	it('is on disk nowhere, so a test leaves no files behind', () => {
		expect(freshDatabase().name).toBe(':memory:');
	});
});

describe('withDatabase', () => {
	it('returns what the body returns', () => {
		const slug = withDatabase((db) => insertProject(db, { slug: 'a', name: 'A' }).slug);

		expect(slug).toBe('a');
	});

	it('closes the database even when the body throws', () => {
		let leaked: ReturnType<typeof freshDatabase> | undefined;

		expect(() =>
			withDatabase((db) => {
				leaked = db;
				throw new Error('boom');
			})
		).toThrow('boom');
		expect(leaked!.open).toBe(false);
	});
});
