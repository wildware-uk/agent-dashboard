import { describe, expect, it } from 'vitest';
import { bearerToken } from './bearer';

describe('reading a bearer token', () => {
	it.each([
		['Bearer abc', 'abc'],
		['bearer abc', 'abc'],
		['  Bearer   abc  ', 'abc']
	])('reads %j', (header, token) => {
		expect(bearerToken(new Headers({ authorization: header }))).toBe(token);
	});

	it.each([['Basic abc'], ['Bearer'], ['Bearer a b'], ['']])('finds none in %j', (header) => {
		expect(bearerToken(new Headers({ authorization: header }))).toBeNull();
	});

	it('finds none without headers', () => {
		expect(bearerToken(undefined)).toBeNull();
		expect(bearerToken(new Headers())).toBeNull();
	});
});
