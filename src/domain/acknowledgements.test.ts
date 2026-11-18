import { describe, expect, it } from 'vitest';
import { createProject } from './projects';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import { isDomainError } from './errors';
import { harness, FIXED_NOW, type Harness } from './testing';
import { oneCard } from './cards';
import { acknowledge, acknowledgementsFor } from './acknowledgements';

/**
 * An agent answering without words (migration 013).
 *
 * The rules worth asserting are the ones a caller can get wrong from the other
 * side of an MCP connection: exactly one target, only the three states, and a
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
	const update = postUpdate(h, { project: project.slug, agentId, body: 'shipped it' });
	return { h, project, agentId, message, update };
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

		const ack = acknowledge(h, {
			agentId,
			card: { kind: 'message', id: message.id },
			state: 'thinking'
		});

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

		acknowledge(h, { agentId, card: { kind: 'message', id: message.id }, state: 'done' });

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
		acknowledge(h, { agentId, card: { kind: 'message', id: message.id }, state: 'thinking' });

		acknowledge(h, { agentId, card: { kind: 'message', id: message.id }, state: 'done' });

		const acks = acknowledgementsFor(h, { message: [message.id] });
		expect(acks).toHaveLength(1);
		expect(acks[0].state).toBe('done');
	});

	it('is safe to re-assert, so a reconnecting agent leaves no trail', () => {
		const { h, agentId, update } = setup();
		acknowledge(h, { agentId, card: { kind: 'update', id: update.id }, state: 'thinking' });
		acknowledge(h, { agentId, card: { kind: 'update', id: update.id }, state: 'thinking' });

		expect(acknowledgementsFor(h, { update: [update.id] })).toHaveLength(1);
	});

	it('works the same way on an update', () => {
		const { h, agentId, update } = setup();

		expect(
			acknowledge(h, { agentId, card: { kind: 'update', id: update.id }, state: 'done' })
		).toMatchObject({
			updateId: update.id,
			messageId: null,
			state: 'done'
		});
	});

	/**
	 * Exactly-one-of moved with the refactor (migration 034).
	 *
	 * A caller now hands over one `card`, so naming two is no longer a shape this
	 * function can be given. The rule lives where the four named arguments are
	 * turned into one card — `oneCard` — and it is still the same refusal.
	 */
	it('refuses a call that names no card, and one that names two', () => {
		expect(codeOf(() => oneCard({}))).toBe('invalid_argument');
		expect(codeOf(() => oneCard({ message: 'm1', update: 'u1' }))).toBe('invalid_argument');
		expect(oneCard({ update: 'u1' })).toEqual({ kind: 'update', id: 'u1' });
	});

	it('refuses a state that is not one of the two', () => {
		const { h, agentId, message } = setup();

		expect(
			codeOf(() =>
				acknowledge(h, {
					agentId,
					card: { kind: 'message', id: message.id },
					state: 'maybe' as unknown as 'done'
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses to file against something that is not there', () => {
		const { h, agentId } = setup();

		expect(
			codeOf(() =>
				acknowledge(h, { agentId, card: { kind: 'message', id: 'nope' }, state: 'done' })
			)
		).toBe('not_found');
		expect(
			codeOf(() => acknowledge(h, { agentId, card: { kind: 'update', id: 'nope' }, state: 'done' }))
		).toBe('not_found');
	});

	it('publishes nothing when it refuses', () => {
		const { h, agentId } = setup();

		codeOf(() => acknowledge(h, { agentId, card: { kind: 'message', id: 'nope' }, state: 'done' }));

		expect(h.eventNames()).not.toContain('ack.updated');
	});
});

describe('acknowledgementsFor', () => {
	it('gives each agent its own say on the same message', () => {
		const { h, agentId, message } = setup();
		const other = h.agent('other');
		acknowledge(h, { agentId, card: { kind: 'message', id: message.id }, state: 'thinking' });
		acknowledge(h, { agentId: other, card: { kind: 'message', id: message.id }, state: 'done' });

		expect(acknowledgementsFor(h, { message: [message.id] })).toHaveLength(2);
	});

	it('answers nothing for a scope that named nothing', () => {
		const { h, agentId, message } = setup();
		acknowledge(h, { agentId, card: { kind: 'message', id: message.id }, state: 'done' });

		expect(acknowledgementsFor(h, {})).toEqual([]);
	});
});

/**
 * `read` (the owner's ask): agents reach for `thinking` and leave it there,
 * because `done` sounds like a claim about the work. The smaller word is the
 * one they will actually use.
 */
describe('saying only that it was read', () => {
	it('records read as a state of its own', () => {
		const { h, agentId, message } = setup();

		const ack = acknowledge(h, {
			agentId,
			card: { kind: 'message', id: message.id },
			state: 'read'
		});

		expect(ack.state).toBe('read');
	});

	it('revises the same row, so read then done is one acknowledgement', () => {
		const { h, agentId, message } = setup();

		const read = acknowledge(h, {
			agentId,
			card: { kind: 'message', id: message.id },
			state: 'read'
		});
		const done = acknowledge(h, {
			agentId,
			card: { kind: 'message', id: message.id },
			state: 'done'
		});

		expect(done.id).toBe(read.id);
		expect(acknowledgementsFor(h, { message: [message.id] })).toHaveLength(1);
		expect(done.state).toBe('done');
	});

	it('still refuses a word nobody defined', () => {
		const { h, agentId, message } = setup();

		expect(
			codeOf(() =>
				acknowledge(h, {
					agentId,
					card: { kind: 'message', id: message.id },
					state: 'busy' as unknown as 'read'
				})
			)
		).toBe('invalid_argument');
	});
});
