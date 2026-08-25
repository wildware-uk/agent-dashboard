import { beforeEach, describe, expect, it } from 'vitest';
import { insertProject } from '$db';
import {
	createProject,
	findProject,
	listProjects,
	resolveProject,
	updateProject
} from './projects';
import { DomainError } from './errors';
import { FIXED_NOW, harness, type Harness } from './testing';

let h: Harness;
beforeEach(() => {
	h = harness();
});

describe('createProject', () => {
	it('returns the stored project, slugged from its name, and says it created it', () => {
		const { project, created } = createProject(h, { name: 'Agent Dashboard' });

		expect(created).toBe(true);
		expect(project).toMatchObject({
			slug: 'agent-dashboard',
			name: 'Agent Dashboard',
			description: null,
			status: 'active',
			pinned: false,
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW
		});
		expect(project.id).toHaveLength(26);
	});

	it('accepts an explicit slug and a description', () => {
		const { project } = createProject(h, {
			name: 'Agent Dashboard',
			slug: 'Feed',
			description: '  the status wall  '
		});

		expect(project).toMatchObject({ slug: 'feed', description: 'the status wall' });
	});

	it('publishes exactly one project.created', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({
			type: 'project.created',
			payload: { projectId: project.id, slug: 'agent-dashboard' }
		});
	});

	it('is idempotent on slug: one row, the same project both times, no second event', () => {
		const first = createProject(h, { name: 'Agent Dashboard' });
		const second = createProject(h, { name: 'Agent Dashboard', description: 'ignored' });

		expect(second.created).toBe(false);
		expect(second.project).toEqual(first.project);
		expect(listProjects(h)).toHaveLength(1);
		expect(h.eventNames()).toEqual(['project.created']);
	});

	it('treats an explicit slug that collides as the same project', () => {
		const first = createProject(h, { name: 'Agent Dashboard' });

		const second = createProject(h, { name: 'Something Else', slug: 'agent-dashboard' });

		expect(second).toEqual({ project: first.project, created: false });
	});

	it('rejects a blank name and an unusable slug', () => {
		expect(() => createProject(h, { name: '  ' })).toThrow(/name is required/);
		expect(() => createProject(h, { name: 'Fine', slug: 'not a slug' })).toThrow(DomainError);
		expect(() => createProject(h, { name: '!!!' })).toThrow(/slug/);
		expect(h.events).toHaveLength(0);
	});
});

describe('listProjects', () => {
	beforeEach(() => {
		createProject(h, { name: 'Active One' });
		createProject(h, { name: 'Pinned' });
		createProject(h, { name: 'Old' });
		updateProject(h, 'pinned', { pinned: true });
		updateProject(h, 'old', { status: 'archived' });
	});

	it('returns pinned first, then newest, and includes archived by default', () => {
		expect(listProjects(h).map((project) => project.slug)).toEqual(['pinned', 'old', 'active-one']);
	});

	it('filters by status', () => {
		expect(listProjects(h, { status: 'active' }).map((p) => p.slug)).toEqual([
			'pinned',
			'active-one'
		]);
		expect(listProjects(h, { status: 'archived' }).map((p) => p.slug)).toEqual(['old']);
	});

	it('returns an empty list rather than throwing when there is nothing', () => {
		expect(listProjects(harness())).toEqual([]);
	});
});

describe('resolving a project reference', () => {
	it('accepts a slug or an id', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(resolveProject(h, 'agent-dashboard')).toEqual(project);
		expect(resolveProject(h, project.id)).toEqual(project);
	});

	it('tolerates the case an agent typed', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(resolveProject(h, ' Agent-Dashboard ')).toEqual(project);
	});

	it('finds a slug that happens to look like an id', () => {
		const project = insertProject(h.db, { slug: '01234567890123456789012345', name: 'Odd' });

		expect(resolveProject(h, '01234567890123456789012345')).toEqual(project);
	});

	it('reports not_found for a stranger, and invalid_argument for nothing at all', () => {
		expect(() => resolveProject(h, 'nope')).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
		expect(() => resolveProject(h, '  ')).toThrowError(
			expect.objectContaining({ code: 'invalid_argument' })
		);
	});

	it('answers undefined rather than throwing when asked to look', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(findProject(h, 'agent-dashboard')).toEqual(project);
		expect(findProject(h, 'nope')).toBeUndefined();
	});
});

describe('updateProject', () => {
	it('writes only the fields given, and stamps updated_at', () => {
		const clock = { at: 1_000 };
		const local = harness({ now: () => clock.at });
		const { project } = createProject(local, { name: 'Agent Dashboard' });
		clock.at = 2_000;

		const renamed = updateProject(local, 'agent-dashboard', { name: 'Dashboard' });

		expect(renamed).toMatchObject({
			id: project.id,
			slug: 'agent-dashboard',
			name: 'Dashboard',
			createdAt: 1_000,
			updatedAt: 2_000
		});
	});

	it('publishes exactly one project.updated', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		updateProject(h, project.id, { pinned: true, status: 'archived' });

		expect(h.eventNames()).toEqual(['project.created', 'project.updated']);
		expect(h.events[1].payload).toEqual({ projectId: project.id, slug: 'agent-dashboard' });
	});

	it('takes every field the owner can change', () => {
		createProject(h, { name: 'Agent Dashboard' });

		const updated = updateProject(h, 'agent-dashboard', {
			name: 'Feed',
			slug: 'feed',
			description: 'the status wall',
			status: 'archived',
			pinned: true
		});

		expect(updated).toMatchObject({
			name: 'Feed',
			slug: 'feed',
			description: 'the status wall',
			status: 'archived',
			pinned: true
		});
	});

	it('clears a description with null', () => {
		createProject(h, { name: 'Agent Dashboard', description: 'gone' });

		expect(updateProject(h, 'agent-dashboard', { description: null }).description).toBeNull();
	});

	it('renaming the slug reports the new slug on the event', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		updateProject(h, project.id, { slug: 'feed' });

		expect(h.events[1].payload).toEqual({ projectId: project.id, slug: 'feed' });
	});

	it('lets a project keep its own slug', () => {
		createProject(h, { name: 'Agent Dashboard' });

		expect(updateProject(h, 'agent-dashboard', { slug: 'agent-dashboard' }).slug).toBe(
			'agent-dashboard'
		);
	});

	it('refuses a slug another project already holds, and writes nothing', () => {
		createProject(h, { name: 'One' });
		createProject(h, { name: 'Two' });

		expect(() => updateProject(h, 'two', { slug: 'one' })).toThrowError(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(listProjects(h).map((p) => p.slug)).toEqual(['two', 'one']);
		expect(h.eventNames()).toEqual(['project.created', 'project.created']);
	});

	it('refuses an empty patch rather than publishing a no-op event', () => {
		createProject(h, { name: 'Agent Dashboard' });

		expect(() => updateProject(h, 'agent-dashboard', {})).toThrow(/at least one/);
		expect(h.eventNames()).toEqual(['project.created']);
	});

	it('validates the fields it is given', () => {
		createProject(h, { name: 'Agent Dashboard' });

		expect(() => updateProject(h, 'agent-dashboard', { name: ' ' })).toThrow(/name is required/);
		expect(() => updateProject(h, 'agent-dashboard', { slug: 'no good' })).toThrow(/lowercase/);
	});

	it('reports not_found for a project that does not exist', () => {
		expect(() => updateProject(h, 'nope', { pinned: true })).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
	});
});
