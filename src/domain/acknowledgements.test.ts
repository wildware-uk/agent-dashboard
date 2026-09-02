import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import { createTask } from './tasks';
import { postMessage } from './messages';
import { isDomainError } from './errors';
import { harness, FIXED_NOW, type Harness } from './testing';
import { acknowledge, acknowledgementsFor } from './acknowledgements';

/**
 * An agent answering without words (migration 013).
 *
 * The rules worth asserting are the ones a caller can get wrong from the other
 * side of an MCP connection: exactly one target, only the two states, and a
 * revision that stays one row.
 */
function setup(h: Harness = harness()) {
	const { project } = createProject(h, { name: 'Agent Dashboard' });
	const agentId = h.agent('scout');
	const message = postMessage(h, {
		project: project.slug,
		author: { kind: 'human' },
		body: 'have a look at the migration'
	});
	const task = createTask(h, { project: project.slug, title: 'look at it' });
	return { h, project, agentId, message, task };
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	return 'no error thrown';
}

describe('acknowledge', () => {
	it('records what the agent said about a message, and tells the browser', () => {
		const { h, agentId, message } = setup();

		const ack = acknowledge(h, { agentId, messageId: message.id, state: 'thinking' });

		expect(ack).toMatchObject({
			agentId,
			messageId: message.id,
			taskId: null,
			state: 'thinking',
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW
		});
		expect(h.eventNames()).toContain('ack.updated');
	});

	it('carries the state on the event, so a tab can decide before refetching', () => {
		const { h, agentId, message } = setup();

		acknowledge(h, { agentId, messageId: message.id, state: 'done' });

		const event = h.events.find((candidate) => candidate.type === 'ack.updated');
		expect(event?.payload).toMatchObject({
			state: 'done',
			messageId: message.id,
			taskId: null,
			agentId
		});
	});

	it('revises the same acknowledgement rather than filing a second one', () => {
		const { h, agentId, message } = setup();
		acknowledge(h, { agentId, messageId: message.id, state: 'thinking' });

		acknowledge(h, { agentId, messageId: message.id, state: 'done' });

		const acks = acknowledgementsFor(h, { messageIds: [message.id] });
		expect(acks).toHaveLength(1);
		expect(acks[0].state).toBe('done');
	});

	it('is safe to re-assert, so a reconnecting agent leaves no trail', () => {
		const { h, agentId, task } = setup();
		acknowledge(h, { agentId, taskId: task.id, state: 'thinking' });
		acknowledge(h, { agentId, taskId: task.id, state: 'thinking' });

		expect(acknowledgementsFor(h, { taskIds: [task.id] })).toHaveLength(1);
	});

	it('works the same way on a task', () => {
		const { h, agentId, task } = setup();

		expect(acknowledge(h, { agentId, taskId: task.id, state: 'done' })).toMatchObject({
			taskId: task.id,
			messageId: null,
			state: 'done'
		});
	});

	it('refuses a call that names neither a message nor a task', () => {
		const { h, agentId } = setup();

		expect(codeOf(() => acknowledge(h, { agentId, state: 'done' }))).toBe('invalid_argument');
	});

	it('refuses a call that names both, rather than picking one', () => {
		const { h, agentId, message, task } = setup();

		expect(
			codeOf(() =>
				acknowledge(h, { agentId, messageId: message.id, taskId: task.id, state: 'done' })
			)
		).toBe('invalid_argument');
	});

	it('refuses a state that is not one of the two', () => {
		const { h, agentId, message } = setup();

		expect(
			codeOf(() =>
				acknowledge(h, {
					agentId,
					messageId: message.id,
					state: 'maybe' as unknown as 'done'
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses to file against something that is not there', () => {
		const { h, agentId } = setup();

		expect(codeOf(() => acknowledge(h, { agentId, messageId: 'nope', state: 'done' }))).toBe(
			'not_found'
		);
		expect(codeOf(() => acknowledge(h, { agentId, taskId: 'nope', state: 'done' }))).toBe(
			'not_found'
		);
	});

	it('publishes nothing when it refuses', () => {
		const { h, agentId } = setup();

		codeOf(() => acknowledge(h, { agentId, messageId: 'nope', state: 'done' }));

		expect(h.eventNames()).not.toContain('ack.updated');
	});
});

describe('acknowledgementsFor', () => {
	it('gives each agent its own say on the same message', () => {
		const { h, agentId, message } = setup();
		const other = h.agent('other');
		acknowledge(h, { agentId, messageId: message.id, state: 'thinking' });
		acknowledge(h, { agentId: other, messageId: message.id, state: 'done' });

		expect(acknowledgementsFor(h, { messageIds: [message.id] })).toHaveLength(2);
	});

	it('answers nothing for a scope that named nothing', () => {
		const { h, agentId, message } = setup();
		acknowledge(h, { agentId, messageId: message.id, state: 'done' });

		expect(acknowledgementsFor(h, {})).toEqual([]);
	});
});
