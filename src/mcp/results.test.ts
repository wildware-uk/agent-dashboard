import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, invalid, notFound, postUpdate } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { failed, guard, ok, projectView, updateView } from './results';
import { toolText } from './testing';

let h: Harness;
beforeEach(() => {
	h = harness();
});

describe('ok', () => {
	it('leads with a sentence an agent can read, then the JSON it has to parse', () => {
		const result = ok('Created project "Feed".', { project: { slug: 'feed' } });

		expect(result.isError).toBeUndefined();
		expect(result.content).toHaveLength(1);
		const text = toolText(result);
		expect(text.startsWith('Created project "Feed".')).toBe(true);
		expect(JSON.parse(text.slice(text.indexOf('\n')))).toEqual({ project: { slug: 'feed' } });
		expect(result.structuredContent).toEqual({ project: { slug: 'feed' } });
	});
});

describe('failed', () => {
	it('is flagged as an error and names the code as well as the reason', () => {
		const result = failed('not_found', 'no such project: feed');

		expect(result.isError).toBe(true);
		expect(toolText(result)).toBe('not_found: no such project: feed');
		expect(result.structuredContent).toEqual({
			error: 'not_found',
			message: 'no such project: feed'
		});
	});
});

describe('guard', () => {
	it('passes a successful result straight through', () => {
		expect(guard(() => ok('fine', {})).isError).toBeUndefined();
	});

	it('turns a domain error into the code the agent should branch on', () => {
		const missing = guard(() => {
			throw notFound('no such project: feed');
		});
		expect(missing).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found', message: 'no such project: feed' }
		});

		const bad = guard(() => {
			throw invalid('body is required');
		});
		expect(bad.structuredContent).toEqual({
			error: 'invalid_argument',
			message: 'body is required'
		});
	});

	it('never leaks the internals of an unexpected failure, but does log it', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = guard(() => {
			throw new TypeError('cannot read properties of undefined (reading `secret`)');
		});

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'internal_error' }
		});
		expect(toolText(result)).not.toContain('secret');
		expect(logged).toHaveBeenCalledOnce();
		logged.mockRestore();
	});
});

describe('projectView', () => {
	it('renames to the snake_case the tool schemas use and dates to ISO 8601', () => {
		const { project } = createProject(h, { name: 'Agent Dashboard', description: 'the wall' });

		expect(projectView(project)).toEqual({
			id: project.id,
			slug: 'agent-dashboard',
			name: 'Agent Dashboard',
			description: 'the wall',
			status: 'active',
			pinned: false,
			created_at: '2026-08-25T09:30:00.000Z',
			updated_at: '2026-08-25T09:30:00.000Z'
		});
	});
});

describe('updateView', () => {
	it('echoes the identifiers and the metadata, but not the body it was just sent', () => {
		const { project } = createProject(h, { name: 'Feed' });
		const agentId = h.agent();
		const update = postUpdate(h, {
			project: 'feed',
			agentId,
			body: 'x'.repeat(5_000),
			title: 'shipped',
			level: 'success'
		});

		const view = updateView(update);

		expect(view).toEqual({
			id: update.id,
			project_id: project.id,
			agent_id: agentId,
			session_id: null,
			title: 'shipped',
			level: 'success',
			pinned: false,
			body_chars: 5_000,
			created_at: '2026-08-25T09:30:00.000Z'
		});
	});
});
