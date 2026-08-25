import { insertMedia } from '$db';
import { createProject, postUpdate, deleteUpdate } from '$domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { attachMediaTool } from './attach-media';

let mcp: McpHarness;
let updateId: string;

beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	createProject(mcp.h, { name: 'Agent Dashboard' });
	updateId = postUpdate(mcp.h, {
		project: 'agent-dashboard',
		agentId: mcp.deps.agent.id,
		body: 'shipped'
	}).id;
	mcp.h.events.length = 0;
});

/** Media whose bytes have already landed, without going through the wire. */
const landed = (agentId = mcp.deps.agent.id) =>
	insertMedia(mcp.h.db, {
		agentId,
		kind: 'image',
		mime: 'image/png',
		bytes: 94,
		sha256: `sha-${Math.random()}`,
		status: 'ready'
	}).id;

const run = (args: Parameters<typeof attachMediaTool.run>[1]) =>
	attachMediaTool.run(mcp.deps, args);

describe('attach_media', () => {
	it('attaches the caller`s own uploads to its update', () => {
		const media = landed();

		const result = run({ update_id: updateId, media_ids: [media] });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			update_id: updateId,
			attached: [media],
			skipped: []
		});
	});

	it('skips another agent`s media instead of stealing it', () => {
		const theirs = landed(mcp.mint('intruder').agentId);

		const result = run({ update_id: updateId, media_ids: [theirs] });

		expect(result.structuredContent).toMatchObject({ attached: [], skipped: [theirs] });
		expect(toolText(result)).toContain('skipped 1');
	});

	it('is safe to retry: the second call attaches nothing and is not an error', () => {
		const media = landed();

		run({ update_id: updateId, media_ids: [media] });
		const again = run({ update_id: updateId, media_ids: [media] });

		expect(again.isError).toBeUndefined();
		expect(again.structuredContent).toMatchObject({ attached: [], skipped: [media] });
	});

	it('reports an update that is gone as not_found', () => {
		deleteUpdate(mcp.h, updateId);

		const result = run({ update_id: updateId, media_ids: [landed()] });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'not_found' });
	});

	it('reports something that is not an id as an argument error', () => {
		const result = run({ update_id: updateId, media_ids: ['../../etc/passwd'] });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'invalid_argument' });
	});

	it('publishes nothing: media.ready is the derivative pipeline`s announcement', () => {
		run({ update_id: updateId, media_ids: [landed()] });

		expect(mcp.h.eventNames()).toEqual([]);
	});
});
