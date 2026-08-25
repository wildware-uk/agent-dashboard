import { describe, expect, it } from 'vitest';
import { DomainError, conflict, invalid, isDomainError, notFound } from './errors';

describe('DomainError', () => {
	it('is an Error carrying a machine-readable code', () => {
		const error = new DomainError('conflict', 'slug taken');

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('DomainError');
		expect(error.code).toBe('conflict');
		expect(error.message).toBe('slug taken');
	});

	it('keeps a cause when one is given', () => {
		const cause = new Error('UNIQUE constraint failed');

		expect(new DomainError('conflict', 'slug taken', { cause }).cause).toBe(cause);
	});
});

describe('the constructors', () => {
	it('stamp the code that names the failure', () => {
		expect(invalid('bad body').code).toBe('invalid_argument');
		expect(notFound('no such project').code).toBe('not_found');
		expect(conflict('slug taken').code).toBe('conflict');
	});
});

describe('isDomainError', () => {
	it('recognises a domain error and nothing else', () => {
		expect(isDomainError(notFound('gone'))).toBe(true);
		expect(isDomainError(new Error('boom'))).toBe(false);
		expect(isDomainError('not_found')).toBe(false);
		expect(isDomainError(null)).toBe(false);
	});
});
