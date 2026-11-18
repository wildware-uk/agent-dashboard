import { describe, expect, it } from 'vitest';
import { newestAt, parseMarks, READ_KEY, READ_MAX, ReadComments } from './unread.svelte';

/**
 * The unread-comment badge (design §7).
 *
 * The owner: "add a badge of how many new unread comments on a card."
 */
function memory(start: string | null = null) {
	let held = start;
	return {
		getItem: () => held,
		setItem: (_key: string, value: string) => {
			held = value;
		},
		read: () => held
	};
}

const agent = (createdAt: number) => ({ createdAt, author: 'agent:a1' });
const owner = (createdAt: number) => ({ createdAt, author: 'human' });

describe('counting what is new', () => {
	it('says nothing is new on a card this browser has never met', () => {
		const marks = new ReadComments(memory());

		expect(marks.unread('c1', [agent(10), agent(20)])).toBe(0);
	});

	it('counts the comments that landed after the reader looked', () => {
		const marks = new ReadComments(memory());
		marks.seed('c1', [agent(10)]);

		expect(marks.unread('c1', [agent(10), agent(20), agent(30)])).toBe(2);
	});

	it('does not count what the owner wrote themselves', () => {
		const marks = new ReadComments(memory());
		marks.seed('c1', [agent(10)]);

		expect(marks.unread('c1', [agent(10), owner(20), agent(30)])).toBe(1);
	});

	it('clears once the reader has looked at the card', () => {
		const marks = new ReadComments(memory());
		marks.seed('c1', [agent(10)]);
		const thread = [agent(10), agent(20)];

		expect(marks.unread('c1', thread)).toBe(1);
		marks.markRead('c1', thread);
		expect(marks.unread('c1', thread)).toBe(0);
	});

	it('keeps cards apart', () => {
		const marks = new ReadComments(memory());
		marks.seed('c1', [agent(10)]);
		marks.seed('c2', [agent(10)]);
		marks.markRead('c1', [agent(10), agent(20)]);

		expect(marks.unread('c1', [agent(10), agent(20)])).toBe(0);
		expect(marks.unread('c2', [agent(10), agent(20)])).toBe(1);
	});

	it('never moves a mark backwards, so a read card cannot unread itself', () => {
		const marks = new ReadComments(memory());
		marks.markRead('c1', [agent(30)]);
		marks.markRead('c1', [agent(10)]);

		expect(marks.unread('c1', [agent(20)])).toBe(0);
	});

	it('leaves a seeded card alone on a second sight', () => {
		const marks = new ReadComments(memory());
		marks.seed('c1', [agent(10)]);
		marks.seed('c1', [agent(10), agent(20)]);

		expect(marks.unread('c1', [agent(10), agent(20)])).toBe(1);
	});
});

describe('remembering across a reload', () => {
	it('writes the marks where the next visit will find them', () => {
		const store = memory();
		new ReadComments(store).markRead('c1', [agent(30)]);

		expect(store.read()).toBe(JSON.stringify({ c1: 30 }));
		expect(new ReadComments(store).unread('c1', [agent(20), agent(40)])).toBe(1);
	});

	it('shrugs off a value somebody else wrote', () => {
		expect(parseMarks('not json')).toEqual({});
		expect(parseMarks(JSON.stringify(['c1']))).toEqual({});
		expect(parseMarks(JSON.stringify({ c1: 'soon', c2: 7 }))).toEqual({ c2: 7 });
		expect(parseMarks(null)).toEqual({});
	});

	it('keeps working when storage is not there at all', () => {
		const marks = new ReadComments(null);
		marks.seed('c1', [agent(10)]);

		expect(marks.unread('c1', [agent(20)])).toBe(1);
	});

	it('keeps working when storage throws', () => {
		const angry = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		};
		const marks = new ReadComments(angry);
		marks.seed('c1', [agent(10)]);

		expect(marks.unread('c1', [agent(20)])).toBe(1);
	});

	it('forgets the oldest rather than growing for ever', () => {
		const marks = new ReadComments(memory());
		for (let index = 0; index < READ_MAX + 10; index += 1) {
			marks.markRead(`c${index}`, [agent(index + 1)]);
		}

		expect(marks.size).toBe(READ_MAX);
		// The oldest mark went; the newest stayed.
		expect(marks.unread('c0', [agent(5)])).toBe(0);
		expect(marks.unread(`c${READ_MAX + 9}`, [agent(1)])).toBe(0);
	});

	it('is stored under a versioned key', () => {
		expect(READ_KEY).toBe('agent-dashboard:read-comments:v1');
	});
});

describe('newestAt', () => {
	it('is the latest comment, whatever order they arrive in', () => {
		expect(newestAt([agent(10), agent(30), agent(20)])).toBe(30);
	});

	it('is zero for a thread with nothing in it', () => {
		expect(newestAt([])).toBe(0);
	});
});
