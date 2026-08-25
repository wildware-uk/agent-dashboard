import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import {
	findProjectById,
	findProjectBySlug,
	insertProject,
	listProjects,
	updateProject
} from './projects';

let db: Db;
beforeEach(() => {
	db = freshDatabase();
});

describe('insertProject', () => {
	it('returns the stored row, with an id, a seq and the documented defaults', () => {
		const project = insertProject(db, { slug: 'dashboard', name: 'Dashboard' });

		expect(project).toMatchObject({
			slug: 'dashboard',
			name: 'Dashboard',
			description: null,
			status: 'active',
			pinned: false
		});
		expect(project.id).toHaveLength(26);
		expect(project.seq).toBe(1);
		expect(project.createdAt).toBe(project.updatedAt);
	});

	it('accepts every column the caller wants to set', () => {
		const project = insertProject(db, {
			id: 'given-id',
			slug: 'archived',
			name: 'Old',
			description: 'gone',
			status: 'archived',
			pinned: true,
			createdAt: 10,
			updatedAt: 20
		});

		expect(project).toEqual({
			seq: 1,
			id: 'given-id',
			slug: 'archived',
			name: 'Old',
			description: 'gone',
			status: 'archived',
			pinned: true,
			createdAt: 10,
			updatedAt: 20
		});
	});

	it('refuses a duplicate slug, because slug is the agent-facing handle', () => {
		insertProject(db, { slug: 'dashboard', name: 'One' });

		expect(() => insertProject(db, { slug: 'dashboard', name: 'Two' })).toThrow(/UNIQUE/);
	});

	it('hands out a seq per insert, in insert order', () => {
		const first = insertProject(db, { slug: 'a', name: 'A' });
		const second = insertProject(db, { slug: 'b', name: 'B' });

		expect(second.seq).toBeGreaterThan(first.seq);
	});
});

describe('finders', () => {
	it('finds by id and by slug, and returns undefined for a stranger', () => {
		const project = insertProject(db, { slug: 'dashboard', name: 'Dashboard' });

		expect(findProjectById(db, project.id)).toEqual(project);
		expect(findProjectBySlug(db, 'dashboard')).toEqual(project);
		expect(findProjectById(db, 'nope')).toBeUndefined();
		expect(findProjectBySlug(db, 'nope')).toBeUndefined();
	});
});

describe('listProjects', () => {
	beforeEach(() => {
		insertProject(db, { slug: 'a', name: 'A', createdAt: 1, updatedAt: 1 });
		insertProject(db, { slug: 'b', name: 'B', pinned: true, createdAt: 2, updatedAt: 2 });
		insertProject(db, { slug: 'c', name: 'C', createdAt: 3, updatedAt: 3 });
		insertProject(db, { slug: 'd', name: 'D', status: 'archived', createdAt: 4, updatedAt: 4 });
	});

	it('puts pinned first, then newest, as the sidebar renders them', () => {
		expect(listProjects(db).map((p) => p.slug)).toEqual(['b', 'd', 'c', 'a']);
	});

	it('filters by status', () => {
		expect(listProjects(db, { status: 'active' }).map((p) => p.slug)).toEqual(['b', 'c', 'a']);
		expect(listProjects(db, { status: 'archived' }).map((p) => p.slug)).toEqual(['d']);
	});
});

describe('updateProject', () => {
	it('writes only the fields it is given', () => {
		const project = insertProject(db, { slug: 'a', name: 'A', description: 'keep' });

		const updated = updateProject(db, project.id, { name: 'Renamed', updatedAt: 99 });

		expect(updated).toMatchObject({
			name: 'Renamed',
			description: 'keep',
			slug: 'a',
			updatedAt: 99
		});
	});

	it('can archive and pin', () => {
		const project = insertProject(db, { slug: 'a', name: 'A' });

		expect(updateProject(db, project.id, { status: 'archived', pinned: true })).toMatchObject({
			status: 'archived',
			pinned: true
		});
	});

	it('returns undefined for an id that is not there', () => {
		expect(updateProject(db, 'nope', { name: 'x' })).toBeUndefined();
	});

	it('is a no-op that still returns the row when given no fields', () => {
		const project = insertProject(db, { slug: 'a', name: 'A' });

		expect(updateProject(db, project.id, {})).toEqual(project);
	});
});
