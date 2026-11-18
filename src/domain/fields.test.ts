import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { isDomainError } from './errors';
import { createProject } from './projects';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import { createRequest } from './requests';
import { FIELDS_PER_CARD, FIELD_VALUE_MAX, fieldSlug, fieldsOn, setField } from './fields';
import type { CardRef } from '$db';

/**
 * What is known about a card (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like… updated by the user and agent alike."
 */
let h: Harness;
let agentId: string;
let slug: string;
let card: CardRef;

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
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
	card = { kind: 'update', id: postUpdate(h, { project: slug, agentId, body: 'shipped' }).id };
});

// A function, not a constant: `agentId` is assigned in `beforeEach`, so a value
// captured at module load would be an agent called `undefined`.
const asAgent = () => ({ kind: 'agent', agentId }) as const;
const asOwner = { kind: 'human' } as const;

describe('setting a field', () => {
	it('records the value, who set it and when', () => {
		const result = setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });

		expect(result.set).toBe(true);
		expect(result.fields).toHaveLength(1);
		expect(result.fields[0]).toMatchObject({
			name: 'Branch',
			slug: 'branch',
			value: 'fix/fees',
			author: `agent:${agentId}`
		});
	});

	it('corrects itself rather than stacking up rows that look the same', () => {
		setField(h, { card, name: 'Branch', value: 'fix/fee', actor: asAgent() });
		const fixed = setField(h, { card, name: 'branch', value: 'fix/fees', actor: asAgent() });

		expect(fixed.fields).toHaveLength(1);
		expect(fixed.fields[0].value).toBe('fix/fees');
		expect(fieldSlug('PR link')).toBe('pr-link');
	});

	it('lets the owner correct an agent, and an agent correct the owner', () => {
		setField(h, { card, name: 'Branch', value: 'wrong', actor: asAgent() });
		setField(h, { card, name: 'Branch', value: 'right', actor: asOwner });

		expect(fieldsOn(h, card)[0]).toMatchObject({ value: 'right', author: 'human' });

		setField(h, { card, name: 'Branch', value: 'righter', actor: asAgent() });
		expect(fieldsOn(h, card)[0].author).toBe(`agent:${agentId}`);
	});

	it('keeps when it first appeared, which is not when it last moved', () => {
		const first = setField(h, { card, name: 'Branch', value: 'a', actor: asAgent() }).fields[0];
		setField(h, { card, name: 'Branch', value: 'b', actor: asAgent() });

		const now = fieldsOn(h, card)[0];
		expect(now.createdAt).toBe(first.createdAt);
		expect(now.updatedAt).toBeGreaterThanOrEqual(first.createdAt);
	});

	it('holds several fields at once, without losing one another', () => {
		setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });
		setField(h, { card, name: 'PR link', value: 'https://example.test/pr/1', actor: asOwner });

		expect(fieldsOn(h, card).map((field) => field.name)).toEqual(['Branch', 'PR link']);
	});

	it('takes one off when the value is null', () => {
		setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });

		const gone = setField(h, { card, name: 'branch', value: null, actor: asOwner });

		expect(gone.set).toBe(false);
		expect(gone.fields).toEqual([]);
	});

	it('works on every kind of card', () => {
		const post = postMessage(h, { author: asOwner, project: slug, body: 'look' });
		const question = createRequest(h, {
			agentId,
			kind: 'confirm',
			question: 'ship it?',
			project: slug
		}).request;

		expect(
			setField(h, {
				card: { kind: 'message', id: post.id },
				name: 'Branch',
				value: 'x',
				actor: asOwner
			}).set
		).toBe(true);
		expect(
			setField(h, {
				card: { kind: 'request', id: question.id },
				name: 'Branch',
				value: 'x',
				actor: asOwner
			}).set
		).toBe(true);
	});

	it('announces the card and the change, so every tab redraws it', () => {
		const before = h.eventNames().length;

		setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });

		expect(h.eventNames().slice(before)).toEqual(['update.updated', 'fields.changed']);
	});

	it('is quiet when the value is already what was asked for', () => {
		setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });
		const before = h.eventNames().length;

		setField(h, { card, name: 'Branch', value: 'fix/fees', actor: asAgent() });

		expect(h.eventNames().slice(before)).toEqual([]);
	});
});

describe('what it refuses', () => {
	it('an empty name, a name of punctuation, and an empty value', () => {
		expect(codeOf(() => setField(h, { card, name: '  ', value: 'x', actor: asOwner }))).toBe(
			'invalid_argument'
		);
		expect(codeOf(() => setField(h, { card, name: '!!', value: 'x', actor: asOwner }))).toBe(
			'invalid_argument'
		);
		expect(codeOf(() => setField(h, { card, name: 'Branch', value: '   ', actor: asOwner }))).toBe(
			'invalid_argument'
		);
	});

	it('a value longer than a note should be', () => {
		expect(
			codeOf(() =>
				setField(h, {
					card,
					name: 'Branch',
					value: 'x'.repeat(FIELD_VALUE_MAX + 1),
					actor: asOwner
				})
			)
		).toBe('invalid_argument');
	});

	it('more fields than a panel can show', () => {
		for (let n = 1; n <= FIELDS_PER_CARD; n += 1) {
			setField(h, { card, name: `field ${n}`, value: 'x', actor: asOwner });
		}

		expect(
			codeOf(() => setField(h, { card, name: 'one too many', value: 'x', actor: asOwner }))
		).toBe('invalid_argument');
		// Correcting an existing one still works when the card is full.
		expect(setField(h, { card, name: 'field 1', value: 'y', actor: asOwner }).set).toBe(true);
	});

	it('clearing a field that is not there, and a card that is not there', () => {
		expect(codeOf(() => setField(h, { card, name: 'Branch', value: null, actor: asOwner }))).toBe(
			'not_found'
		);
		expect(
			codeOf(() =>
				setField(h, { card: { kind: 'update', id: 'nope' }, name: 'B', value: 'x', actor: asOwner })
			)
		).toBe('not_found');
	});
});
