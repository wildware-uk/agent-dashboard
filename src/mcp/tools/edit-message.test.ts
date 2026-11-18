import { describe, expect, it } from 'vitest';
import { createProject, findMessage, postMessage, postUpdate } from '$domain';
import { mcpHarness, type McpHarness } from '../testing';
import { editMessageTool } from './edit-message';

/**
 * `edit_message` (migration 033) — an agent correcting a line it already said.
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 * The rule that matters most is whose words they are: a thread carries several
 * agents and the owner, and one rewriting another's line would make the whole
 * conversation unreliable.
 */
function aThread(mcp: McpHarness) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	const update = postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'shipped'
	});
	return { project, update };
}

describe('correcting your own line', () => {
	it('replaces the words and reports the edit back', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const said = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			updateId: update.id,
			body: 'the file is src/wrong.ts'
		});

		const result = await editMessageTool.run(mcp.deps, {
			message_id: said.id,
			body: 'the file is src/right.ts'
		});

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			message: { id: said.id, body: 'the file is src/right.ts' }
		});
		expect(findMessage(mcp.h, said.id)?.body).toBe('the file is src/right.ts');
	});

	it('says when it was edited, so the reader is not told twice over', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const said = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			updateId: update.id,
			body: 'one'
		});

		const before = await editMessageTool.run(mcp.deps, { message_id: said.id, body: 'two' });

		// Absent on an untouched message, present once it has been corrected.
		expect(
			(before.structuredContent as { message: { edited_at?: string } }).message.edited_at
		).toBeTruthy();
	});

	it('refuses the owner`s words, and leaves them exactly as they were', async () => {
		const mcp = mcpHarness();
		const { update } = aThread(mcp);
		const theirs = postMessage(mcp.h, {
			author: { kind: 'human' },
			updateId: update.id,
			body: 'did that work?'
		});

		const result = await editMessageTool.run(mcp.deps, {
			message_id: theirs.id,
			body: 'it did, obviously'
		});

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: 'invalid_argument' }
		});
		expect(findMessage(mcp.h, theirs.id)?.body).toBe('did that work?');
	});

	it('refuses a message that is not there', async () => {
		const mcp = mcpHarness();

		expect(
			await editMessageTool.run(mcp.deps, { message_id: 'nope', body: 'hello?' })
		).toMatchObject({ isError: true, structuredContent: { error: 'not_found' } });
	});
});
