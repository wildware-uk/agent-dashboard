import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import {
	countUnseenUpdates,
	findProjectById,
	findProjectBySlug,
	insertProject,
	listProjects,
	markProjectSeen,
	updateProject
} from './projects';
import { insertAgent } from './agents';
import { insertUpdate, softDeleteUpdate } from './updates';

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
			updatedAt: 20,
			// Migration 006: a project starts with the dashboard's own styling.
			theme: null,
			// Migration 009: and with the board's default three columns.
			board: null,
			// Migration 011: never opened, which badges its whole history rather
			// than nothing.
			ownerSeenAt: null
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

describe('the theme column (migration 006)', () => {
	it('starts null, which is the dashboard’s own styling', () => {
		expect(insertProject(db, { slug: 'p', name: 'P' }).theme).toBeNull();
	});

	it('stores and reads back a theme as an object, not as text', () => {
		const project = insertProject(db, { slug: 'p', name: 'P' });

		const updated = updateProject(db, project.id, {
			theme: { background: '#101820', accent: '#ffb300', logoMediaId: 'm1' }
		});

		expect(updated?.theme).toEqual({
			background: '#101820',
			accent: '#ffb300',
			logoMediaId: 'm1'
		});
		expect(findProjectBySlug(db, 'p')?.theme).toEqual(updated?.theme);
	});

	it('clears it when the patch says null', () => {
		const project = insertProject(db, { slug: 'p', name: 'P' });
		updateProject(db, project.id, { theme: { accent: '#ffb300' } });

		expect(updateProject(db, project.id, { theme: null })?.theme).toBeNull();
	});

	it('leaves it alone when the patch does not mention it', () => {
		const project = insertProject(db, { slug: 'p', name: 'P' });
		updateProject(db, project.id, { theme: { accent: '#ffb300' } });

		expect(updateProject(db, project.id, { name: 'Renamed' })?.theme).toEqual({
			accent: '#ffb300'
		});
	});
});

describe('markProjectSeen', () => {
	it('stamps when the owner looked, and leaves updated_at alone', () => {
		const project = insertProject(db, { slug: 'p', name: 'P', createdAt: 10, updatedAt: 10 });

		const seen = markProjectSeen(db, project.id, 900);

		expect(seen).toMatchObject({ ownerSeenAt: 900, updatedAt: 10 });
		expect(findProjectById(db, project.id)?.ownerSeenAt).toBe(900);
	});

	it('answers undefined for a project that is not there', () => {
		expect(markProjectSeen(db, 'nope', 900)).toBeUndefined();
	});
});

describe('countUnseenUpdates', () => {
	let agentId: string;
	let projectId: string;
	beforeEach(() => {
		agentId = insertAgent(db, { name: 'claude', tokenHash: 'h1' }).id;
		projectId = insertProject(db, { slug: 'p', name: 'P' }).id;
	});

	const post = (at: number, project = projectId) =>
		insertUpdate(db, { projectId: project, agentId, body: 'x', createdAt: at });

	it('counts a never-opened project’s whole history, not nothing', () => {
		post(100);
		post(200);

		expect(countUnseenUpdates(db)).toEqual({ [projectId]: 2 });
	});

	it('counts only what landed after the owner last looked', () => {
		post(100);
		markProjectSeen(db, projectId, 150);
		post(200);

		expect(countUnseenUpdates(db)).toEqual({ [projectId]: 1 });
	});

	it('leaves a project out entirely once it is caught up', () => {
		post(100);
		markProjectSeen(db, projectId, 150);

		expect(countUnseenUpdates(db)).toEqual({});
	});

	it('ignores deleted updates, so a badge cannot count a card nobody can open', () => {
		const update = post(100);
		post(200);
		softDeleteUpdate(db, update.id);

		expect(countUnseenUpdates(db)).toEqual({ [projectId]: 1 });
	});

	it('keeps projects apart', () => {
		const other = insertProject(db, { slug: 'other', name: 'Other' }).id;
		post(100);
		post(200, other);
		markProjectSeen(db, other, 300);

		expect(countUnseenUpdates(db)).toEqual({ [projectId]: 1 });
	});
});
