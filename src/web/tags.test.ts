import { describe, expect, it } from 'vitest';
import { tagLook, tagsFor, tagsOn } from './tags';
import { aCardTag, aTag } from './testing';

/**
 * How a tag looks, and which cards wear which (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc."
 */
describe('what a tag looks like', () => {
	it('paints each palette name, and falls back to grey', () => {
		expect(tagLook('rose')).toContain('rose');
		expect(tagLook(null)).toBe(tagLook('grey'));
		// A colour from a future version of the server is not a reason to render
		// an unstyled chip.
		expect(tagLook('chartreuse')).toBe(tagLook('grey'));
	});
});

describe('which words a card wears', () => {
	const bug = aTag({ id: 't1', name: 'Bug' });
	const feature = aTag({ id: 't2', name: 'Feature' });
	const known = [bug, feature];

	it('reads them in the order the project decided them, not the order they were clicked', () => {
		const worn = [
			aCardTag({ id: 'c1', tagId: 't2', card: { kind: 'update', id: 'u1' } }),
			aCardTag({ id: 'c2', tagId: 't1', card: { kind: 'update', id: 'u1' } })
		];

		expect(tagsOn({ kind: 'update', id: 'u1' }, worn, known).map((tag) => tag.name)).toEqual([
			'Bug',
			'Feature'
		]);
	});

	it('keeps cards apart, including two kinds sharing an id', () => {
		const worn = [
			aCardTag({ id: 'c1', tagId: 't1', card: { kind: 'update', id: 'x' } }),
			aCardTag({ id: 'c2', tagId: 't2', card: { kind: 'message', id: 'x' } })
		];

		expect(tagsOn({ kind: 'update', id: 'x' }, worn, known).map((tag) => tag.id)).toEqual(['t1']);
		expect(tagsOn({ kind: 'message', id: 'x' }, worn, known).map((tag) => tag.id)).toEqual(['t2']);
	});

	it('ignores a word the page does not know, rather than rendering a blank chip', () => {
		const worn = [aCardTag({ tagId: 'gone', card: { kind: 'update', id: 'u1' } })];

		expect(tagsOn({ kind: 'update', id: 'u1' }, worn, known)).toEqual([]);
	});
});

describe('which words a picker offers', () => {
	it('offers this project`s, and nobody else`s', () => {
		const known = [
			aTag({ id: 't1', projectId: 'p1' }),
			aTag({ id: 't2', projectId: 'p2', name: 'Elsewhere' })
		];

		expect(tagsFor('p1', known).map((tag) => tag.id)).toEqual(['t1']);
		expect(tagsFor(null, known)).toEqual([]);
	});
});
