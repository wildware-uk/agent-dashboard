import { describe, expect, it } from 'vitest';
import { ID_LENGTH, isId, newId } from './ids';

describe('newId', () => {
	it('mints a 26 character ULID', () => {
		const id = newId();

		expect(id).toHaveLength(ID_LENGTH);
		expect(isId(id)).toBe(true);
	});

	it('never repeats', () => {
		const ids = new Set(Array.from({ length: 1000 }, newId));

		expect(ids.size).toBe(1000);
	});

	it('sorts in mint order, even within the same millisecond', () => {
		const ids = Array.from({ length: 500 }, newId);

		expect([...ids].sort()).toEqual(ids);
	});
});

describe('isId', () => {
	it('rejects anything that is not a ULID', () => {
		expect(isId('')).toBe(false);
		expect(isId('not-an-id')).toBe(false);
		// Lower case, and the letters ULID's alphabet leaves out.
		expect(isId(newId().toLowerCase())).toBe(false);
		expect(isId('I'.repeat(26))).toBe(false);
	});
});
