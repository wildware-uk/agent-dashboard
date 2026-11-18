import { describe, expect, it } from 'vitest';
import { markdownToPlainText } from './plain-text';

describe('markdown as plain text', () => {
	it.each([
		['**done** and _checked_', 'done and checked'],
		['run `npm test` first', 'run npm test first'],
		['see [the PR](https://example.com/pr/1)', 'see the PR'],
		['## Shipped\n\nAll green.', 'Shipped\nAll green.'],
		['- one\n- two', '• one\n• two'],
		['3. three\n4. four', '3. three\n4. four'],
		['> quoted', 'quoted'],
		['![diagram](x.png) above', 'diagram above'],
		['```ts\nconst a = 1;\n```', 'const a = 1;'],
		['line one\nline two', 'line one\nline two'],
		['---\n\nafter the rule', 'after the rule']
	])('%j reads as %j', (markdown, plain) => {
		expect(markdownToPlainText(markdown)).toBe(plain);
	});

	it('leaves text that only looks like markdown alone', () => {
		expect(markdownToPlainText('2 * 3 * 4 in snake_case_name')).toBe(
			'2 * 3 * 4 in snake_case_name'
		);
	});

	it('shows raw HTML as the text it is', () => {
		expect(markdownToPlainText('<b>hi</b>')).toBe('<b>hi</b>');
	});
});
