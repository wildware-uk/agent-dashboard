import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { createProject } from './projects';
import { postMessage, deleteMessage } from './messages';
import { isDomainError } from './errors';
import { assertEmoji, react, reactionsFor } from './reactions';

/**
 * Reactions (migration 024).
 *
 * The owner asked for "a nice simple way to allow quick communication" and
 * noticed it could stand in for the acknowledgement system. What is asserted
 * here is the switch behaviour — reacting is a state, not an event — and the
 * line between an emoji and a message.
 */

let h: Harness;
let agentId: string;
let slug: string;

function refusalCode(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	return 'no error thrown';
}

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
});

const aMessage = () =>
	postMessage(h, { author: { kind: 'human' }, project: slug, body: 'have a look at this' });

describe('reacting', () => {
	it('records who reacted with what, and says so', () => {
		const message = aMessage();

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		const result = react(h, {
			messageId: message.id,
			actor: { kind: 'agent', agentId },
			emoji: '👀'
		});

		expect(result.on).toBe(true);
		expect(result.reactions).toHaveLength(1);
		expect(result.reactions[0]).toMatchObject({ emoji: '👀', actor: `agent:${agentId}` });
		expect(events).toEqual([
			expect.objectContaining({
				type: 'reaction.updated',
				payload: expect.objectContaining({ on: true })
			})
		]);
	});

	it('toggles: the same call again takes it back', () => {
		const message = aMessage();
		react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '👍' });

		const second = react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '👍' });

		expect(second.on).toBe(false);
		expect(second.reactions).toEqual([]);
	});

	it('is idempotent when the caller says which way it wants', () => {
		const message = aMessage();
		react(h, { messageId: message.id, actor: { kind: 'agent', agentId }, emoji: '✅', on: true });

		// A retry after a dropped connection must not undo the reaction it thought
		// it was making — which is exactly what a toggle would do.
		const again = react(h, {
			messageId: message.id,
			actor: { kind: 'agent', agentId },
			emoji: '✅',
			on: true
		});

		expect(again.on).toBe(true);
		expect(again.changed).toBe(false);
		expect(again.reactions).toHaveLength(1);
	});

	it('says nothing when nothing changed', () => {
		const message = aMessage();
		react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '🎉', on: true });

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '🎉', on: true });

		expect(events).toEqual([]);
	});

	it('keeps the owner’s and an agent’s apart, and counts both', () => {
		const message = aMessage();

		react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '👍' });
		react(h, { messageId: message.id, actor: { kind: 'agent', agentId }, emoji: '👍' });

		expect(reactionsFor(h, [message.id])).toHaveLength(2);
	});

	it('refuses a message that is gone', () => {
		const message = aMessage();
		deleteMessage(h, { messageId: message.id, by: { kind: 'human' } });

		expect(
			refusalCode(() => react(h, { messageId: message.id, actor: { kind: 'human' }, emoji: '👍' }))
		).toBe('not_found');
	});
});

describe('what counts as an emoji', () => {
	it('takes the character itself', () => {
		expect(assertEmoji('🚀')).toBe('🚀');
	});

	it('translates the shortcodes an agent will actually write', () => {
		expect(assertEmoji(':eyes:')).toBe('👀');
		expect(assertEmoji('tick')).toBe('✅');
		expect(assertEmoji(':+1:')).toBe('👍');
	});

	it('refuses a sentence dressed up as a reaction', () => {
		expect(refusalCode(() => assertEmoji('looks good to me'))).toBe('invalid_argument');
		expect(refusalCode(() => assertEmoji('lgtm'))).toBe('invalid_argument');
		expect(refusalCode(() => assertEmoji(''))).toBe('invalid_argument');
	});

	it('refuses something far too long to be one', () => {
		expect(refusalCode(() => assertEmoji('🚀'.repeat(40)))).toBe('invalid_argument');
	});
});
