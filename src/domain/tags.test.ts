import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { isDomainError } from './errors';
import { createProject } from './projects';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import { createRequest } from './requests';
import {
	TAGS_PER_CARD,
	TAG_MAX_LENGTH,
	defineTag,
	listTags,
	renameTag,
	retireTag,
	tagCard,
	tagSlug,
	tagsForCards
} from './tags';
import type { CardRef } from '$db';

/**
 * A project's own words (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
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

describe('defining a word for a project', () => {
	it('keeps what was typed, and compares on the normalised form', () => {
		const tag = defineTag(h, { project: slug, name: '  High Priority ', colour: 'amber' });

		expect(tag).toMatchObject({ name: 'High Priority', slug: 'high-priority', colour: 'amber' });
		expect(tagSlug('High  Priority!')).toBe('high-priority');
	});

	it('hands back the same tag rather than refusing a second definition', () => {
		const first = defineTag(h, { project: slug, name: 'Bug' });
		const again = defineTag(h, { project: slug, name: 'bug' });

		expect(again.id).toBe(first.id);
		expect(listTags(h, { project: slug })).toHaveLength(1);
	});

	it('records whether an agent or the owner decided it', () => {
		expect(defineTag(h, { project: slug, name: 'Bug', agentId }).agentId).toBe(agentId);
		expect(defineTag(h, { project: slug, name: 'Feature' }).agentId).toBeNull();
	});

	it('announces it, so every open picker gains the word', () => {
		const before = h.eventNames().length;

		defineTag(h, { project: slug, name: 'Bug' });

		expect(h.eventNames().slice(before)).toEqual(['tags.changed']);
	});

	it('refuses an empty word, a huge one, and one made only of punctuation', () => {
		expect(codeOf(() => defineTag(h, { project: slug, name: '   ' }))).toBe('invalid_argument');
		expect(
			codeOf(() => defineTag(h, { project: slug, name: 'x'.repeat(TAG_MAX_LENGTH + 1) }))
		).toBe('invalid_argument');
		expect(codeOf(() => defineTag(h, { project: slug, name: '!!!' }))).toBe('invalid_argument');
	});

	it('refuses a colour outside the palette, which the themes have to render', () => {
		expect(codeOf(() => defineTag(h, { project: slug, name: 'Bug', colour: '#ff0000' }))).toBe(
			'invalid_argument'
		);
	});

	it('refuses a project nobody has', () => {
		expect(codeOf(() => defineTag(h, { project: 'nope', name: 'Bug' }))).toBe('not_found');
	});
});

describe('putting a word on a card', () => {
	it('tags a card in one call, and toggles it off in the next', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });

		expect(tagCard(h, { card, tag: tag.id, actor: { kind: 'human' } })).toMatchObject({ on: true });
		expect(tagsForCards(h, { update: [card.id] })).toHaveLength(1);

		expect(tagCard(h, { card, tag: tag.id, actor: { kind: 'human' } }).on).toBe(false);
		expect(tagsForCards(h, { update: [card.id] })).toEqual([]);
	});

	it('takes the word rather than the id, which is what a tool sends', () => {
		defineTag(h, { project: slug, name: 'Bug' });

		expect(tagCard(h, { card, tag: 'BUG', actor: { kind: 'human' } }).on).toBe(true);
	});

	it('defines the word on the way when asked to, so one call is enough', () => {
		const result = tagCard(h, {
			card,
			tag: 'needs design',
			actor: { kind: 'agent', agentId },
			create: true
		});

		expect(result.on).toBe(true);
		expect(listTags(h, { project: slug }).map((tag) => tag.name)).toEqual(['needs design']);
		// On the record as the agent's word, because it was the agent that invented it.
		expect(listTags(h, { project: slug })[0].agentId).toBe(agentId);
	});

	it('refuses a word the project has not defined, unless asked to define it', () => {
		expect(codeOf(() => tagCard(h, { card, tag: 'bug', actor: { kind: 'human' } }))).toBe(
			'not_found'
		);
	});

	it('refuses a word belonging to another project', () => {
		const other = createProject(h, { name: 'Elsewhere' }).project.slug;
		const theirs = defineTag(h, { project: other, name: 'Bug' });

		expect(codeOf(() => tagCard(h, { card, tag: theirs.id, actor: { kind: 'human' } }))).toBe(
			'invalid_argument'
		);
	});

	it('works on every kind of card, which is what the refactor bought', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });
		const post = postMessage(h, { author: { kind: 'human' }, project: slug, body: 'look' });
		const question = createRequest(h, {
			agentId,
			kind: 'confirm',
			question: 'ship it?',
			project: slug
		}).request;

		expect(
			tagCard(h, { card: { kind: 'message', id: post.id }, tag: tag.id, actor: { kind: 'human' } })
				.on
		).toBe(true);
		expect(
			tagCard(h, {
				card: { kind: 'request', id: question.id },
				tag: tag.id,
				actor: { kind: 'human' }
			}).on
		).toBe(true);
	});

	it('announces the card and the change, so the feed redraws either way', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });
		const before = h.eventNames().length;

		tagCard(h, { card, tag: tag.id, actor: { kind: 'human' } });

		// The card's own event for the store that renders that kind, and
		// `tags.changed` because which card wears which rides in the feed's
		// snapshot — and the feed does not watch message or request events.
		expect(h.eventNames().slice(before)).toEqual(['update.updated', 'tags.changed']);
	});

	it('is quiet when the tag is already where it was asked to be', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });
		tagCard(h, { card, tag: tag.id, actor: { kind: 'human' }, on: true });
		const before = h.eventNames().length;

		tagCard(h, { card, tag: tag.id, actor: { kind: 'human' }, on: true });

		expect(h.eventNames().slice(before)).toEqual([]);
	});

	it('stops a card wearing more words than anybody can read', () => {
		for (let n = 1; n <= TAGS_PER_CARD; n += 1) {
			const tag = defineTag(h, { project: slug, name: `tag ${n}` });
			tagCard(h, { card, tag: tag.id, actor: { kind: 'human' }, on: true });
		}
		const extra = defineTag(h, { project: slug, name: 'one too many' });

		expect(
			codeOf(() => tagCard(h, { card, tag: extra.id, actor: { kind: 'human' }, on: true }))
		).toBe('invalid_argument');
	});

	it('refuses a card that is not there', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });

		expect(
			codeOf(() =>
				tagCard(h, { card: { kind: 'update', id: 'nope' }, tag: tag.id, actor: { kind: 'human' } })
			)
		).toBe('not_found');
	});
});

describe('renaming and retiring', () => {
	it('renames the word everywhere at once', () => {
		const tag = defineTag(h, { project: slug, name: 'Buig' });
		tagCard(h, { card, tag: tag.id, actor: { kind: 'human' } });

		const fixed = renameTag(h, tag.id, { name: 'Bug', colour: 'rose' });

		expect(fixed).toMatchObject({ name: 'Bug', slug: 'bug', colour: 'rose' });
		expect(tagsForCards(h, { update: [card.id] })[0].tagId).toBe(tag.id);
	});

	it('refuses a rename onto a word the project already has', () => {
		defineTag(h, { project: slug, name: 'Bug' });
		const other = defineTag(h, { project: slug, name: 'Feature' });

		expect(codeOf(() => renameTag(h, other.id, { name: 'bug' }))).toBe('invalid_argument');
	});

	it('retires a word, taking it off every card', () => {
		const tag = defineTag(h, { project: slug, name: 'Bug' });
		tagCard(h, { card, tag: tag.id, actor: { kind: 'human' } });

		retireTag(h, tag.id);

		expect(listTags(h, { project: slug })).toEqual([]);
		expect(tagsForCards(h, { update: [card.id] })).toEqual([]);
	});

	it('refuses to rename or retire a tag that is not there', () => {
		expect(codeOf(() => renameTag(h, 'nope', { name: 'Bug' }))).toBe('not_found');
		expect(codeOf(() => retireTag(h, 'nope'))).toBe('not_found');
	});
});
