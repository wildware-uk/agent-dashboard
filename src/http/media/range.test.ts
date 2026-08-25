import { describe, expect, it } from 'vitest';
import { resolveRange } from './range';

const SIZE = 1000;

describe('resolveRange', () => {
	it('sends the whole file when nothing was asked for', () => {
		expect(resolveRange(null, SIZE)).toEqual({ kind: 'whole' });
	});

	it('reads an open-ended range, which is what a media element opens with', () => {
		expect(resolveRange('bytes=0-', SIZE)).toEqual({
			kind: 'partial',
			range: { start: 0, end: 999 }
		});
	});

	it('reads a closed range inclusively', () => {
		expect(resolveRange('bytes=100-199', SIZE)).toEqual({
			kind: 'partial',
			range: { start: 100, end: 199 }
		});
	});

	it('reads a suffix range as the LAST n bytes', () => {
		// `bytes=-500` is the tail, not "the first 500". Getting this backwards
		// serves the wrong bytes with a 206, which is worse than failing.
		expect(resolveRange('bytes=-500', SIZE)).toEqual({
			kind: 'partial',
			range: { start: 500, end: 999 }
		});
	});

	it('clamps a suffix longer than the file to the whole file', () => {
		expect(resolveRange('bytes=-5000', SIZE)).toEqual({
			kind: 'partial',
			range: { start: 0, end: 999 }
		});
	});

	it('clamps an end past the last byte', () => {
		expect(resolveRange('bytes=900-99999', SIZE)).toEqual({
			kind: 'partial',
			range: { start: 900, end: 999 }
		});
	});

	it('refuses a start at or past the end of the file', () => {
		expect(resolveRange(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: 'unsatisfiable' });
		expect(resolveRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
	});

	it('refuses a backwards range', () => {
		expect(resolveRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
	});

	it('refuses any range against an empty representation', () => {
		expect(resolveRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
	});

	it('ignores a multipart or malformed header rather than failing', () => {
		// Legal to answer 200 with the whole body, and no player asks for these.
		expect(resolveRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'whole' });
		expect(resolveRange('items=0-99', SIZE)).toEqual({ kind: 'whole' });
		expect(resolveRange('bytes=-', SIZE)).toEqual({ kind: 'whole' });
	});
});
