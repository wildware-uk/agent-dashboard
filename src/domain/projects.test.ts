import { beforeEach, describe, expect, it } from 'vitest';
import { insertMedia, insertProject } from '$db';
import {
	createProject,
	findProject,
	listProjects,
	markProjectSeen,
	resolveProject,
	unseenUpdateCounts,
	updateProject
} from './projects';
import { postUpdate } from './updates';
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

/**
 * Per-project styling (design §7, §8).
 *
 * The colour check is a security boundary rather than a formatting preference:
 * these values reach a CSS custom property on the owner's dashboard, and agents
 * can set them. Most of what is asserted here is what the domain refuses.
 */
describe('themes', () => {
	const themed = (theme: Parameters<typeof updateProject>[2]['theme']) =>
		updateProject(h, 'dash', { theme });

	beforeEach(() => {
		createProject(h, { name: 'Dash', slug: 'dash' });
	});

	it('takes a background, an accent and a logo', () => {
		const media = readyImage();

		expect(
			themed({ background: '#101820', accent: '#ffb300', logoMediaId: media.id }).theme
		).toEqual({ background: '#101820', accent: '#ffb300', logoMediaId: media.id });
	});

	it('normalises a shorthand colour, so one colour is one string', () => {
		expect(themed({ accent: '#F0A' }).theme).toEqual({ accent: '#ff00aa' });
	});

	it('merges rather than replacing, so setting one thing keeps the others', () => {
		themed({ background: '#101820' });

		expect(themed({ accent: '#ffb300' }).theme).toEqual({
			background: '#101820',
			accent: '#ffb300'
		});
	});

	it('clears one field when it is explicitly null', () => {
		themed({ background: '#101820', accent: '#ffb300' });

		expect(themed({ background: null }).theme).toEqual({ accent: '#ffb300' });
	});

	it('clears the whole theme when the theme itself is null', () => {
		themed({ background: '#101820' });

		expect(updateProject(h, 'dash', { theme: null }).theme).toBeNull();
	});

	it('is null rather than empty once the last field goes', () => {
		themed({ accent: '#ffb300' });

		expect(themed({ accent: null }).theme).toBeNull();
	});

	it.each([
		['a named colour', 'red'],
		['a var reference', 'var(--surface)'],
		['a url', 'url(https://evil.example/x.png)'],
		['anything with a semicolon', '#fff; position: fixed'],
		['a closing brace', '#fff}html{display:none'],
		['an expression', 'color-mix(in srgb, red, blue)'],
		['rgb notation', 'rgb(1, 2, 3)'],
		['too few digits', '#ff'],
		['too many digits', '#1234567'],
		['no hash at all', '112233']
	])('refuses %s', (_name, value) => {
		expect(() => themed({ accent: value })).toThrow(/hex colour/);
	});

	it('refuses a logo that is not a media row at all', () => {
		expect(() => themed({ logoMediaId: 'nope' })).toThrow(/no such media/);
	});

	it('refuses a logo the pipeline has not finished with', () => {
		const media = insertMedia(h.db, {
			agentId: h.agent('uploader'),
			kind: 'image',
			mime: 'image/png',
			bytes: 10,
			sha256: 'a'.repeat(64),
			status: 'pending'
		});

		expect(() => themed({ logoMediaId: media.id })).toThrow(/still being processed/);
	});

	it('refuses a video as a logo, which has no still to show', () => {
		const media = insertMedia(h.db, {
			agentId: h.agent('uploader'),
			kind: 'video',
			mime: 'video/mp4',
			bytes: 10,
			sha256: 'b'.repeat(64),
			status: 'ready'
		});

		expect(() => themed({ logoMediaId: media.id })).toThrow(/must be an image/);
	});

	it('lets a logo stand in for the name', () => {
		const media = readyImage();

		expect(themed({ logoMediaId: media.id, logoReplacesName: true }).theme).toEqual({
			logoMediaId: media.id,
			logoReplacesName: true
		});
	});

	it('refuses the flag without a logo to show instead of the name', () => {
		expect(() => themed({ logoReplacesName: true })).toThrow(/needs a logo/);
	});

	it('drops the flag with the logo, so no header renders a name-shaped hole', () => {
		const media = readyImage();
		themed({ logoMediaId: media.id, logoReplacesName: true });

		expect(themed({ logoMediaId: null }).theme).toBeNull();
	});

	it('stores nothing for false, which is the default anyway', () => {
		const media = readyImage();
		themed({ logoMediaId: media.id, logoReplacesName: true });

		expect(themed({ logoReplacesName: false }).theme).toEqual({ logoMediaId: media.id });
	});

	it('publishes once, so every open tab restyles without a reload', () => {
		h.events.length = 0;
		themed({ accent: '#ffb300' });

		expect(h.eventNames()).toEqual(['project.updated']);
	});

	function readyImage() {
		return insertMedia(h.db, {
			agentId: h.agent('uploader'),
			kind: 'image',
			mime: 'image/png',
			bytes: 10,
			sha256: 'c'.repeat(64),
			status: 'ready'
		});
	}
});

/**
 * Board columns (design §7).
 *
 * A column gathers task states; a state belongs to exactly one column. Anything
 * else draws the same task in two lanes.
 */
describe('the board', () => {
	beforeEach(() => {
		if (!findProject(h, 'dash')) createProject(h, { name: 'Dash', slug: 'dash' });
	});

	const board = (value: unknown) => updateProject(h, 'dash', { board: value });

	it('takes an ordered set of columns', () => {
		expect(
			board({
				columns: [
					{ title: 'Queue', states: ['todo'] },
					{ title: 'Doing', states: ['claimed'] }
				]
			}).board
		).toEqual({
			columns: [
				{ title: 'Queue', states: ['todo'] },
				{ title: 'Doing', states: ['claimed'] }
			]
		});
	});

	it('lets one column gather several states', () => {
		expect(board({ columns: [{ title: 'Over', states: ['done', 'cancelled'] }] }).board).toEqual({
			columns: [{ title: 'Over', states: ['done', 'cancelled'] }]
		});
	});

	it('refuses the same state in two columns, which would draw a task twice', () => {
		expect(() =>
			board({
				columns: [
					{ title: 'One', states: ['todo'] },
					{ title: 'Two', states: ['todo'] }
				]
			})
		).toThrow(/already in another column/);
	});

	it('refuses a column that gathers nothing, which no task could enter', () => {
		expect(() => board({ columns: [{ title: 'Empty', states: [] }] })).toThrow(/at least one/);
	});

	it('refuses a state that is not one', () => {
		expect(() => board({ columns: [{ title: 'X', states: ['blocked'] }] })).toThrow(
			/must be any of/
		);
	});

	it('refuses a board with no columns at all', () => {
		expect(() => board({ columns: [] })).toThrow(/at least one column/);
	});

	it('refuses a nameless column', () => {
		expect(() => board({ columns: [{ title: '  ', states: ['todo'] }] })).toThrow(/title/);
	});

	it('caps how many columns a board is allowed', () => {
		const columns = Array.from({ length: 7 }, (_, index) => ({
			title: `C${index}`,
			states: []
		}));

		expect(() => board({ columns })).toThrow(/at most 6 columns/);
	});

	it('restores the default when set to null', () => {
		board({ columns: [{ title: 'Queue', states: ['todo'] }] });

		expect(board(null).board).toBeNull();
	});

	it('replaces wholesale rather than merging, unlike the theme', () => {
		board({
			columns: [
				{ title: 'One', states: ['todo'] },
				{ title: 'Two', states: ['claimed'] }
			]
		});

		expect(board({ columns: [{ title: 'Only', states: ['done'] }] }).board?.columns).toHaveLength(
			1
		);
	});
});

describe('markProjectSeen', () => {
	it('stamps the project and tells every open tab, so a badge cannot clear in one window only', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		const seen = markProjectSeen(h, project.slug);

		expect(seen.ownerSeenAt).toBe(FIXED_NOW);
		expect(h.eventNames()).toContain('project.updated');
	});

	it('does not bump updated_at: reading a project is not editing it', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(markProjectSeen(h, project.slug).updatedAt).toBe(project.updatedAt);
	});

	it('takes a slug or an id, like everything else that names a project', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });

		expect(markProjectSeen(h, project.id).id).toBe(project.id);
	});

	it('says which project it could not find', () => {
		expect(() => markProjectSeen(h, 'nope')).toThrow(DomainError);
	});
});

describe('unseenUpdateCounts', () => {
	it('counts what has landed since the owner last looked, per project', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard' });
		const agentId = h.agent('scout');
		postUpdate(h, { project: project.slug, agentId, body: 'one' });

		expect(unseenUpdateCounts(h)).toEqual({ [project.id]: 1 });

		markProjectSeen(h, project.slug);

		expect(unseenUpdateCounts(h)).toEqual({});
	});

	it('leaves a caught-up project out rather than reporting a zero nobody should badge', () => {
		createProject(h, { name: 'Quiet' });

		expect(unseenUpdateCounts(h)).toEqual({});
	});
});
