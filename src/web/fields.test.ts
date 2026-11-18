import { describe, expect, it } from 'vitest';
import { fieldsOn, linkOf } from './fields';
import { aCardField } from './testing';

/**
 * What is noted on a card, as the page reads it (migration 040).
 */
describe('which notes belong to a card', () => {
	const onUpdate = aCardField({ id: 'f1', card: { kind: 'update', id: 'u1' } });
	const onPost = aCardField({ id: 'f2', card: { kind: 'message', id: 'u1' }, name: 'PR link' });

	it('keeps cards apart, including two kinds sharing an id', () => {
		const all = [onUpdate, onPost];

		expect(fieldsOn({ kind: 'update', id: 'u1' }, all).map((f) => f.id)).toEqual(['f1']);
		expect(fieldsOn({ kind: 'message', id: 'u1' }, all).map((f) => f.id)).toEqual(['f2']);
		expect(fieldsOn({ kind: 'update', id: 'other' }, all)).toEqual([]);
	});
});

describe('a value that is a link', () => {
	it('is rendered as one, for http and https', () => {
		expect(linkOf('https://example.test/pr/1')).toBe('https://example.test/pr/1');
		expect(linkOf('  http://example.test/  ')).toBe('http://example.test/');
	});

	it('is not one for anything else, which is what keeps scripts out of a card', () => {
		// The value was written by an agent, so this is the guard that matters.
		expect(linkOf('javascript:alert(1)')).toBeNull();
		expect(linkOf('data:text/html,<script>')).toBeNull();
		expect(linkOf('file:///etc/passwd')).toBeNull();
		expect(linkOf('httpevil://example.test')).toBeNull();
		expect(linkOf('fix/fees')).toBeNull();
		expect(linkOf('https://')).toBeNull();
	});
});
