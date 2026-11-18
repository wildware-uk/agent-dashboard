import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX_LENGTH, repliesLabel, summaryOf } from './summary';

/**
 * The one line a folded card shows (design §7).
 *
 * The owner: "allow me to collapse a card." A fold that showed only a name
 * would be a row you have to open to find out whether you wanted it.
 */
describe('the line a folded card keeps', () => {
	it('is the words, without the marks around them', () => {
		expect(summaryOf('## Shipped it\n\nThe **canary** held for `20m`.')).toBe(
			'Shipped it The canary held for 20m.'
		);
	});

	it('keeps a link`s text and drops its URL, which is not readable prose', () => {
		expect(summaryOf('See [the pull request](https://example.com/very/long/url) for why.')).toBe(
			'See the pull request for why.'
		);
	});

	it('drops a code block rather than showing its first line', () => {
		expect(summaryOf('Before\n\n```json\n{ "a": 1 }\n```\n\nAfter')).toBe('Before After');
	});

	it('drops an image entirely, alt text and all', () => {
		// The card never showed those words, so a fold must not invent them.
		expect(summaryOf('![a screenshot of the failure](/media/x.png) it failed')).toBe('it failed');
	});

	it('flattens bullets into one line', () => {
		expect(summaryOf('- one\n- two\n- three')).toBe('one two three');
	});

	it('cuts long prose on a word, and says it was cut', () => {
		const long = 'word '.repeat(60);
		const short = summaryOf(long);

		expect(short.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH + 1);
		expect(short.endsWith('…')).toBe(true);
		expect(short).not.toContain('wor…');
	});

	it('is empty when there are no words, so the card can say so itself', () => {
		expect(summaryOf('![just a picture](/media/x.png)')).toBe('');
		expect(summaryOf('   ')).toBe('');
	});
});

describe('how many replies are hidden', () => {
	it('counts in words, and says nothing about none', () => {
		expect(repliesLabel(0)).toBe('');
		expect(repliesLabel(1)).toBe('1 reply');
		expect(repliesLabel(4)).toBe('4 replies');
	});
});
