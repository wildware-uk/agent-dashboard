import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, type Db } from './testing';
import { insertProject } from './projects';
import { insertAgent } from './agents';
import { insertUpdate } from './updates';
import {
	addCardTag,
	deleteTag,
	findCardTag,
	findTagById,
	findTagBySlug,
	insertTag,
	listCardTags,
	listTags,
	removeCardTag,
	updateTag
} from './tags';

/**
 * A project's own words, and one of them on a card (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts."
 */
let db: Db;
let projectId: string;
let agentId: string;
let updateId: string;

beforeEach(() => {
	db = freshDatabase();
	projectId = insertProject(db, { slug: 'dash', name: 'Dash' }).id;
	agentId = insertAgent(db, { name: 'scout', tokenHash: 'h1' }).id;
	updateId = insertUpdate(db, { projectId, agentId, body: 'shipped' }).id;
});

const aTag = (overrides: Partial<Parameters<typeof insertTag>[1]> = {}) =>
	insertTag(db, { projectId, name: 'Bug', slug: 'bug', ...overrides });

describe('defining a tag', () => {
	it('stores the word, the normalised form and who defined it', () => {
		const tag = aTag({ colour: 'rose', agentId });

		expect(tag).toMatchObject({
			projectId,
			name: 'Bug',
			slug: 'bug',
			colour: 'rose',
			agentId
		});
		expect(findTagById(db, tag.id)).toMatchObject({ slug: 'bug' });
	});

	it('is the owner`s when no agent defined it', () => {
		expect(aTag().agentId).toBeNull();
	});

	it('hands back the existing one rather than refusing a second definition', () => {
		const first = aTag({ colour: 'rose' });
		const again = aTag({ name: 'bug', colour: 'amber' });

		expect(again.id).toBe(first.id);
		// The first definition's colour stands: a second opinion about the shade is
		// not worth overwriting a word the project is already using.
		expect(again.colour).toBe('rose');
		expect(listTags(db, [projectId])).toHaveLength(1);
	});

	it('keeps projects apart: two may both have "bug"', () => {
		const other = insertProject(db, { slug: 'other', name: 'Other' }).id;
		aTag();
		insertTag(db, { projectId: other, name: 'Bug', slug: 'bug' });

		expect(listTags(db, [projectId])).toHaveLength(1);
		expect(listTags(db, [other])).toHaveLength(1);
		expect(listTags(db)).toHaveLength(2);
	});

	it('finds one by its word', () => {
		const tag = aTag();

		expect(findTagBySlug(db, projectId, 'bug')?.id).toBe(tag.id);
		expect(findTagBySlug(db, projectId, 'feature')).toBeUndefined();
	});

	it('renames and recolours one, which moves it on every card at once', () => {
		const tag = aTag();

		const renamed = updateTag(db, tag.id, { name: 'Defect', slug: 'defect', colour: 'amber' });

		expect(renamed).toMatchObject({ name: 'Defect', slug: 'defect', colour: 'amber' });
		expect(updateTag(db, 'nope', { name: 'x' })).toBeUndefined();
	});
});

describe('putting a tag on a card', () => {
	it('records who put it there', () => {
		const tag = aTag();

		const put = addCardTag(db, {
			card: { kind: 'update', id: updateId },
			tagId: tag.id,
			author: 'human'
		});

		expect(put).toMatchObject({
			tagId: tag.id,
			card: { kind: 'update', id: updateId },
			author: 'human'
		});
	});

	it('is quiet the second time: the same click twice is the same tag', () => {
		const tag = aTag();
		const card = { kind: 'update', id: updateId } as const;
		addCardTag(db, { card, tagId: tag.id, author: 'human' });

		expect(addCardTag(db, { card, tagId: tag.id, author: 'agent:a1' })).toBeUndefined();
		expect(listCardTags(db, { update: [updateId] })).toHaveLength(1);
	});

	it('comes off again', () => {
		const tag = aTag();
		const card = { kind: 'update', id: updateId } as const;
		addCardTag(db, { card, tagId: tag.id, author: 'human' });

		expect(removeCardTag(db, card, tag.id)).toBe(true);
		expect(findCardTag(db, card, tag.id)).toBeUndefined();
		expect(removeCardTag(db, card, tag.id)).toBe(false);
	});

	it('reads a page of cards in one query per kind', () => {
		const second = insertUpdate(db, { projectId, agentId, body: 'again' }).id;
		const bug = aTag();
		const feature = insertTag(db, { projectId, name: 'Feature', slug: 'feature' });
		addCardTag(db, { card: { kind: 'update', id: updateId }, tagId: bug.id, author: 'human' });
		addCardTag(db, { card: { kind: 'update', id: second }, tagId: feature.id, author: 'human' });

		const found = listCardTags(db, { update: [updateId, second] });

		expect(found.map((row) => row.tagId)).toEqual([bug.id, feature.id]);
		expect(listCardTags(db, { update: [] })).toEqual([]);
	});

	it('takes the tag off every card when the tag is retired', () => {
		const tag = aTag();
		addCardTag(db, { card: { kind: 'update', id: updateId }, tagId: tag.id, author: 'human' });

		expect(deleteTag(db, tag.id)).toBe(true);
		expect(listCardTags(db, { update: [updateId] })).toEqual([]);
		expect(findTagById(db, tag.id)).toBeUndefined();
		expect(deleteTag(db, tag.id)).toBe(false);
	});
});
