import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, harness, type Harness } from './testing';
import { isDomainError } from './errors';
import { createProject } from './projects';
import { createRequest } from './requests';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import {
	WORK_SUMMARY_CHARS,
	acknowledgeCard,
	listWorkInScope,
	oneCard,
	pinCard,
	reactToCard,
	reactionsForCards,
	countOpenWorkInScope,
	resolveCard,
	setStatus,
	type CardRef
} from './cards';

/**
 * The features every card shares (migration 034).
 *
 * The owner: "there are many discrepancies between the card types, they should
 * all share the same features, and be implemented in a generic modular
 * fashion." These tests are that sentence: the same act, asserted once per
 * kind, through one function.
 */
let h: Harness;
let agentId: string;
let cards: Record<string, CardRef>;

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	throw new Error('expected a refusal');
}

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	const slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;

	cards = {
		update: { kind: 'update', id: postUpdate(h, { project: slug, agentId, body: 'shipped' }).id },
		message: {
			kind: 'message',
			id: postMessage(h, { author: { kind: 'human' }, project: slug, body: 'have a look' }).id
		},
		request: {
			kind: 'request',
			id: createRequest(h, { agentId, kind: 'confirm', question: 'ship it?', project: slug })
				.request.id
		}
	};
});

describe('pinning', () => {
	it('works on every kind of card, not only an update', () => {
		for (const card of Object.values(cards)) {
			expect(pinCard(h, { card, pinned: true }), card.kind).toEqual({ card, pinned: true });
			expect(resolveCard(h, card).pinned, card.kind).toBe(true);
		}
	});

	it('unpins again, and is quiet when nothing changed', () => {
		const card = cards.message;
		pinCard(h, { card, pinned: true });
		const before = h.eventNames().length;

		// Pinning what is already pinned announces nothing: a double click is one
		// pin, not two refetches.
		pinCard(h, { card, pinned: true });
		expect(h.eventNames().slice(before)).toEqual([]);

		pinCard(h, { card, pinned: false });
		expect(resolveCard(h, card).pinned).toBe(false);
	});

	it('announces each kind in the vocabulary its own readers already watch', () => {
		const said: string[] = [];
		for (const card of Object.values(cards)) {
			const before = h.eventNames().length;
			pinCard(h, { card, pinned: true });
			said.push(...h.eventNames().slice(before));
		}

		// Not one new `card.pinned` name that four stores would have to learn.
		expect(said).toEqual(['update.updated', 'message.updated', 'request.updated']);
	});

	it('refuses a card that is not there', () => {
		expect(codeOf(() => pinCard(h, { card: { kind: 'update', id: 'nope' }, pinned: true }))).toBe(
			'not_found'
		);
	});
});

describe('reacting', () => {
	it('works on every kind of card, not only a message', () => {
		for (const card of Object.values(cards)) {
			const result = reactToCard(h, { card, actor: { kind: 'human' }, emoji: '👀' });

			expect(result.on, card.kind).toBe(true);
			expect(reactionsForCards(h, card.kind, [card.id]).map((one) => one.emoji)).toEqual(['👀']);
		}
	});

	it('keeps one card`s emoji off another`s', () => {
		reactToCard(h, { card: cards.update, actor: { kind: 'human' }, emoji: '🎉' });

		expect(reactionsForCards(h, 'message', [cards.message.id])).toEqual([]);
	});

	it('toggles, and counts one reactor once', () => {
		const card = cards.request;
		reactToCard(h, { card, actor: { kind: 'human' }, emoji: '✅' });
		reactToCard(h, { card, actor: { kind: 'agent', agentId }, emoji: '✅' });

		expect(reactionsForCards(h, card.kind, [card.id])).toHaveLength(2);
		expect(reactToCard(h, { card, actor: { kind: 'human' }, emoji: '✅' }).on).toBe(false);
		expect(reactionsForCards(h, card.kind, [card.id])).toHaveLength(1);
	});

	it('says which card it was on, so a browser can put it in the right place', () => {
		reactToCard(h, { card: cards.update, actor: { kind: 'human' }, emoji: '👍' });

		const [reaction] = reactionsForCards(h, 'update', [cards.update.id]);
		expect(reaction.card).toEqual(cards.update);
		// `messageId` is null on anything that is not a message: the older name
		// still means what it always did.
		expect(reaction.messageId).toBe(null);
	});

	it('refuses something that is not an emoji, and a card that is gone', () => {
		expect(
			codeOf(() => reactToCard(h, { card: cards.update, actor: { kind: 'human' }, emoji: 'nice' }))
		).toBe('invalid_argument');
		expect(
			codeOf(() =>
				reactToCard(h, {
					card: { kind: 'update', id: 'nope' },
					actor: { kind: 'human' },
					emoji: '👍'
				})
			)
		).toBe('not_found');
	});
});

describe('acknowledging', () => {
	it('works on every kind of card, not only a message and a task', () => {
		for (const card of Object.values(cards)) {
			const ack = acknowledgeCard(h, { agentId, card, state: 'read' });

			expect(ack.card, card.kind).toEqual(card);
			expect(ack.state).toBe('read');
		}
	});

	it('revises the same row rather than filing a second one', () => {
		acknowledgeCard(h, { agentId, card: cards.update, state: 'thinking' });
		const done = acknowledgeCard(h, { agentId, card: cards.update, state: 'done' });

		expect(done.state).toBe('done');
		expect(done.createdAt).toBe(done.updatedAt);
	});
});

describe('naming one card out of four arguments', () => {
	it('takes the one that was given', () => {
		expect(oneCard({ update: 'u1' })).toEqual({ kind: 'update', id: 'u1' });
		expect(oneCard({ request: 'r1' })).toEqual({ kind: 'request', id: 'r1' });
	});

	it('refuses none, and refuses two', () => {
		expect(codeOf(() => oneCard({}))).toBe('invalid_argument');
		expect(codeOf(() => oneCard({ update: '  ' }))).toBe('invalid_argument');
		expect(codeOf(() => oneCard({ update: 'u1', message: 'm1' }))).toBe('invalid_argument');
	});
});

/**
 * Work is a state a card is in (migration 035).
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card, in progress, done, blocked
 * etc."
 */
describe('marking a card as work', () => {
	it('marks a card, moves it along, and takes the mark off again', () => {
		const card = cards.update;

		expect(setStatus(h, { card, status: 'todo' })).toEqual({ card, status: 'todo' });
		expect(setStatus(h, { card, status: 'in_progress' }).status).toBe('in_progress');
		expect(setStatus(h, { card, status: null }).status).toBe(null);
		expect(resolveCard(h, card).status).toBe(null);
	});

	it('works on one of the owner`s own posts, which is how they ask for work', () => {
		const card = cards.message;

		expect(setStatus(h, { card, status: 'todo' }).status).toBe('todo');
	});

	it('counts the open ones, which is what a heartbeat reports', () => {
		setStatus(h, { card: cards.update, status: 'in_progress' });
		setStatus(h, { card: cards.message, status: 'blocked' });

		expect(countOpenWorkInScope(h, agentId, null)).toBe(2);

		// Finishing takes it out of the count; cancelling does too.
		setStatus(h, { card: cards.update, status: 'done' });
		setStatus(h, { card: cards.message, status: 'cancelled' });
		expect(countOpenWorkInScope(h, agentId, null)).toBe(0);
	});

	it('announces it, so the feed and every agent see it', () => {
		const before = h.eventNames().length;

		setStatus(h, { card: cards.update, status: 'todo' });

		expect(h.eventNames().slice(before)).toEqual(['update.updated']);
	});

	it('is quiet when the state is already what was asked for', () => {
		setStatus(h, { card: cards.update, status: 'todo' });
		const before = h.eventNames().length;

		setStatus(h, { card: cards.update, status: 'todo' });

		expect(h.eventNames().slice(before)).toEqual([]);
	});

	it('refuses a question, which ends by being answered rather than by a state', () => {
		expect(codeOf(() => setStatus(h, { card: cards.request, status: 'done' }))).toBe(
			'invalid_argument'
		);
	});

	it('refuses a word that is not one of the five, and a card that is gone', () => {
		expect(
			codeOf(() => setStatus(h, { card: cards.update, status: 'shipped' as unknown as 'done' }))
		).toBe('invalid_argument');
		expect(
			codeOf(() => setStatus(h, { card: { kind: 'update', id: 'nope' }, status: 'todo' }))
		).toBe('not_found');
	});
});

/**
 * Asking what the work is (migration 035).
 *
 * The owner: "allow agents to filter cards by work status, ie get all cards in
 * project x that are status y."
 */
describe('listing work by state', () => {
	beforeEach(() => {
		setStatus(h, { card: cards.update, status: 'blocked' });
		setStatus(h, { card: cards.message, status: 'in_progress' });
	});

	it('gives back only the states asked for', () => {
		const blocked = listWorkInScope(h, agentId, { statuses: ['blocked'] });

		expect(blocked.map((item) => item.id)).toEqual([cards.update.id]);
		expect(blocked[0]).toMatchObject({
			kind: 'update',
			status: 'blocked',
			author: `agent:${agentId}`
		});
	});

	it('takes more than one state at a time', () => {
		const open = listWorkInScope(h, agentId, { statuses: ['blocked', 'in_progress'] });

		expect(open.map((item) => item.id).sort()).toEqual([cards.message.id, cards.update.id].sort());
	});

	it('gives every marked card when no state is named, and never an unmarked one', () => {
		const all = listWorkInScope(h, agentId, {});

		expect(all).toHaveLength(2);
		// The question on the same project carries no state and is not work.
		expect(all.some((item) => item.id === cards.request.id)).toBe(false);
	});

	it('puts what moved most recently first', () => {
		// The harness clock is fixed, so the two marks above are the same instant.
		// A later one is written directly, which is what a real second click is.
		h.db
			.prepare('UPDATE updates SET status_at = ? WHERE id = ?')
			.run(FIXED_NOW + 60_000, cards.update.id);

		expect(listWorkInScope(h, agentId, {})[0].id).toBe(cards.update.id);
	});

	it('keeps projects apart, and says so when a project is named', () => {
		const other = createProject(h, { name: 'Elsewhere' }).project.slug;
		const far = postUpdate(h, { project: other, agentId, body: 'over here' }).id;
		setStatus(h, { card: { kind: 'update', id: far }, status: 'blocked' });

		const here = listWorkInScope(h, agentId, { project: 'agent-dashboard', statuses: ['blocked'] });

		expect(here.map((item) => item.id)).toEqual([cards.update.id]);
	});

	it('refuses a project nobody has, rather than answering "nothing"', () => {
		expect(codeOf(() => listWorkInScope(h, agentId, { project: 'no-such-project' }))).toBe(
			'not_found'
		);
	});

	it('refuses a state that is not one of the five', () => {
		expect(codeOf(() => listWorkInScope(h, agentId, { statuses: ['nearly' as 'todo'] }))).toBe(
			'invalid_argument'
		);
	});

	it('carries the start of the card, not the whole of it', () => {
		const long = postUpdate(h, {
			project: 'agent-dashboard',
			agentId,
			body: 'x'.repeat(WORK_SUMMARY_CHARS + 50)
		}).id;
		setStatus(h, { card: { kind: 'update', id: long }, status: 'todo' });

		const found = listWorkInScope(h, agentId, { statuses: ['todo'] })[0];
		expect(found.summary).toHaveLength(WORK_SUMMARY_CHARS + 1);
		expect(found.summary.endsWith('…')).toBe(true);
	});

	it('stops at the limit it was given', () => {
		expect(listWorkInScope(h, agentId, { limit: 1 })).toHaveLength(1);
	});
});
