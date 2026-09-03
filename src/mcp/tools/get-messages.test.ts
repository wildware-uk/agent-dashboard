import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, heartbeat, postMessage, registerSession } from '$domain';
import { readCursorSeq } from '$db';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { getMessagesTool } from './get-messages';

/**
 * `get_messages` (design §5), through the tool rather than the domain: what an
 * agent is actually handed, and what it is told about the cursor it is moving.
 */

let mcp: McpHarness;
let slug: string;
let projectId: string;

/** The owner says something, scoped to a project unless the test says otherwise. */
function fromOwner(body: string, scope: Record<string, string> = { project: slug }) {
	return postMessage(mcp.h, { author: { kind: 'human' }, body, ...scope });
}

async function get(args: Record<string, unknown> = {}) {
	return await getMessagesTool.run(mcp.deps, args as never);
}

/** The structured payload, typed enough to read fields off. */
function payload(result: Awaited<ReturnType<typeof get>>) {
	return result.structuredContent as {
		messages: { id: string; body: string; author: string; project_id: string | null }[];
		count: number;
		cursor: string;
		unread: number;
		marked_read: boolean;
	};
}

beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	const project = createProject(mcp.h, { name: 'Agent Dashboard' }).project;
	slug = project.slug;
	projectId = project.id;
});

describe('get_messages', () => {
	it('returns only the messages after the calling agent’s cursor', async () => {
		fromOwner('first');
		fromOwner('second');

		expect(payload(await get()).messages.map((message) => message.body)).toEqual([
			'first',
			'second'
		]);
		// The cursor moved with the read, so the second call has nothing to say.
		expect(payload(await get()).count).toBe(0);

		fromOwner('third');
		expect(payload(await get()).messages.map((message) => message.body)).toEqual(['third']);
	});

	it('advances the cursor by default, because mark_read defaults to true', async () => {
		const message = fromOwner('ship it');

		const read = payload(await get());

		expect(read.marked_read).toBe(true);
		expect(readCursorSeq(mcp.h.db, mcp.deps.agent.id, projectId)).toBe(message.seq);
		expect(read.unread).toBe(0);
	});

	it('leaves the cursor untouched for mark_read: false, so the same messages return', async () => {
		fromOwner('ship it');

		const peek = payload(await get({ mark_read: false }));

		expect(peek.marked_read).toBe(false);
		expect(peek.unread).toBe(1);
		expect(readCursorSeq(mcp.h.db, mcp.deps.agent.id, projectId)).toBe(0);
		expect(payload(await get({ mark_read: false })).messages.map((m) => m.body)).toEqual([
			'ship it'
		]);
	});

	it('reads one project at a time', async () => {
		const other = createProject(mcp.h, { name: 'Other' }).project;
		fromOwner('for other', { project: other.slug });
		fromOwner('for dashboard');

		const scoped = payload(await get({ project: slug }));

		expect(scoped.messages.map((message) => message.body)).toEqual(['for dashboard']);
		// Only this project was marked read: cursors are per project (migration
		// 025), so the message in the other one is still waiting rather than
		// stepped over.
		expect(scoped.unread).toBe(1);
	});

	it('resumes from a cursor it handed out', async () => {
		fromOwner('first');
		const second = fromOwner('second');

		const page = payload(await get({ mark_read: false }));
		expect(page.cursor).toBe(String(second.seq));

		// Everything the first call handed over is behind that cursor, so resuming
		// from it is how an agent polls without re-reading.
		expect(payload(await get({ since: page.cursor, mark_read: false })).count).toBe(0);
	});

	it('never hands an agent its own messages back', async () => {
		postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			body: 'mine',
			project: slug
		});
		fromOwner('yours');

		expect(payload(await get()).messages.map((message) => message.body)).toEqual(['yours']);
	});

	it('reports each message as human or agent:<agent_id>, in snake_case fields', async () => {
		const other = mcp.mint('other');
		postMessage(mcp.h, {
			author: { kind: 'agent', agentId: other.agentId },
			body: 'from a peer',
			project: slug
		});
		const owner = fromOwner('from the owner');

		const [peer, human] = payload(await get()).messages;

		expect(peer.author).toBe(`agent:${other.agentId}`);
		expect(human).toMatchObject({ id: owner.id, author: 'human' });
		expect(Object.keys(human).sort()).toEqual([
			'author',
			'body',
			'created_at',
			'id',
			'project_id',
			// Migration 014: the owner's own feed post this answers, if any.
			'reply_to',
			'task_id',
			'update_id'
		]);
	});

	it('says in words how much is waiting, so a model need not parse the JSON', async () => {
		expect(toolText(await get())).toContain('No new messages');

		fromOwner('one');
		expect(toolText(await get())).toContain('1 new message');
	});

	it('refuses a cursor it did not issue, and an unknown project, as fixable errors', async () => {
		expect(await get({ since: 'yesterday' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
		expect(await get({ project: 'nope' })).toMatchObject({
			isError: true,
			structuredContent: { error: 'not_found' }
		});
	});

	it('is the count the heartbeat reports, so an agent is never told to look twice', async () => {
		const { session } = registerSession(mcp.h, { agentId: mcp.deps.agent.id });
		fromOwner('first');
		fromOwner('second');

		expect(heartbeat(mcp.h, { sessionId: session.id, agentId: mcp.deps.agent.id })).toMatchObject({
			unreadMessages: 2
		});

		await get();

		expect(heartbeat(mcp.h, { sessionId: session.id, agentId: mcp.deps.agent.id })).toMatchObject({
			unreadMessages: 0
		});
	});
});
