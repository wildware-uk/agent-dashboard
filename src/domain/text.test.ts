import { describe, expect, it } from 'vitest';
import { optionalText, requiredText } from './text';

describe('requiredText', () => {
	it('returns the value trimmed', () => {
		expect(requiredText('  Dashboard \n', 'name', 20)).toBe('Dashboard');
	});

	it('rejects a value that is empty or only whitespace, naming the field', () => {
		expect(() => requiredText('', 'name', 20)).toThrow(/name is required/);
		expect(() => requiredText('   ', 'name', 20)).toThrow(/name is required/);
	});

	it('rejects a value longer than the limit, naming the limit', () => {
		expect(() => requiredText('a'.repeat(21), 'name', 20)).toThrow(/name must be at most 20/);
		expect(requiredText('a'.repeat(20), 'name', 20)).toHaveLength(20);
	});

	it('measures the trimmed length, so trailing whitespace is not an error', () => {
		expect(requiredText(`${'a'.repeat(20)}   `, 'name', 20)).toHaveLength(20);
	});

	it('fails with invalid_argument', () => {
		expect(() => requiredText('', 'name', 20)).toThrowError(
			expect.objectContaining({ code: 'invalid_argument' })
		);
	});
});

describe('optionalText', () => {
	it('collapses absence and emptiness to null', () => {
		expect(optionalText(undefined, 'title', 20)).toBeNull();
		expect(optionalText(null, 'title', 20)).toBeNull();
		expect(optionalText('   ', 'title', 20)).toBeNull();
	});

	it('returns a present value trimmed', () => {
		expect(optionalText(' Shipped ', 'title', 20)).toBe('Shipped');
	});

	it('still enforces the limit', () => {
		expect(() => optionalText('a'.repeat(21), 'title', 20)).toThrow(/title must be at most 20/);
	});
});
