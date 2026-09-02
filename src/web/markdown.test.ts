import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_LENGTH, excerpt, renderMarkdown } from './markdown';

/**
 * The security test of this slice (design §8). Every case below is something an
 * agent could put in an update body, and none of it may become live markup in
 * the owner's browser.
 */
describe('untrusted agent markdown', () => {
	it('renders a script tag as text rather than as markup', () => {
		const html = renderMarkdown('<script>alert("xss")</script>');

		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;script&gt;');
	});

	it('escapes inline HTML, so an event-handler attribute is only ever text', () => {
		const html = renderMarkdown('hello <img src=x onerror="alert(1)"> world');

		// The whole tag survives as characters — `onerror=` included — but the `<`
		// is escaped, so the browser has no element to hang a handler on.
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
	});

	it('escapes HTML that markdown put inside a code fence', () => {
		const html = renderMarkdown('```\n<iframe src="evil"></iframe>\n```');

		expect(html).toContain('<pre>');
		expect(html).not.toContain('<iframe');
	});

	it('refuses to make a link out of a javascript: URL', () => {
		const html = renderMarkdown('[click me](javascript:alert(1))');

		// markdown-it leaves the source as literal text rather than emitting an
		// anchor, so there is no href of any kind to click.
		expect(html).not.toContain('href');
		expect(html).toContain('[click me](javascript:alert(1))');
	});

	it('never emits a raw HTML comment, which could hide markup from a reader', () => {
		const html = renderMarkdown('<!-- <script>alert(1)</script> -->');

		expect(html).not.toContain('<!--');
	});
});

describe('markdown an agent would actually write', () => {
	it('renders headings, emphasis, lists and code', () => {
		const html = renderMarkdown('# Shipped\n\n- **fast**\n- `npm test`\n');

		expect(html).toContain('<h1>Shipped</h1>');
		expect(html).toContain('<strong>fast</strong>');
		expect(html).toContain('<code>npm test</code>');
		expect(html).toContain('<li>');
	});

	it('keeps a single newline as a line break, the way a chat client would', () => {
		expect(renderMarkdown('one\ntwo')).toContain('<br');
	});

	it('linkifies a bare URL and hardens the anchor', () => {
		const html = renderMarkdown('see https://example.com/x for details');

		expect(html).toContain('href="https://example.com/x"');
		expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
		expect(html).toContain('target="_blank"');
	});

	it('hardens an authored link the same way', () => {
		const html = renderMarkdown('[docs](https://example.com)');

		expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
	});

	it('is empty for an empty body, so a card renders nothing rather than "undefined"', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('   ')).toBe('');
	});
});

describe('wide content', () => {
	it('wraps a table so it scrolls inside itself instead of widening the page', () => {
		// A table's min-content width is the sum of its columns, and one that cannot
		// shrink drags the layout with it: a five-column table pushed a 375px phone's
		// layout viewport to 723px, zooming the whole dashboard out.
		const html = renderMarkdown('| kind | answer |\n| --- | --- |\n| text | string |');

		expect(html).toContain('<div class="md-scroll"><table>');
		expect(html).toContain('</table></div>');
	});

	it('leaves prose alone', () => {
		expect(renderMarkdown('just a sentence')).not.toContain('md-scroll');
	});
});

/**
 * The plain-text opening a link preview carries (design §7).
 *
 * The rule that matters is the last one: whatever this cannot flatten, it must
 * never emit as markup — an unfurled link is text in somebody else's app.
 */
describe('excerpt', () => {
	it('keeps a plain body as it is', () => {
		expect(excerpt('The release went out at 14:02.')).toBe('The release went out at 14:02.');
	});

	it('drops heading hashes, bullets and quote markers', () => {
		expect(excerpt('## Deployed\n- one\n- two\n> a note')).toBe('Deployed one two a note');
	});

	it('unwraps emphasis without eating the words', () => {
		expect(excerpt('**done** and _dusted_ and ~~gone~~')).toBe('done and dusted and gone');
	});

	it('keeps a link’s text and drops its address', () => {
		expect(excerpt('see [the run](https://ci.example.com/1234) for detail')).toBe(
			'see the run for detail'
		);
	});

	it('keeps an image’s alt text and leaves no stray punctuation', () => {
		expect(excerpt('before ![a screenshot](/media/x/thumb-640) after')).toBe(
			'before a screenshot after'
		);
	});

	it('drops a fenced code block rather than showing its fence', () => {
		expect(excerpt('Ran it:\n```sh\nnpm test\n```\nAll green.')).toBe('Ran it: All green.');
	});

	it('keeps inline code as its contents', () => {
		expect(excerpt('run `npm test` first')).toBe('run npm test first');
	});

	it('collapses the whitespace a multi-line body is full of', () => {
		expect(excerpt('one\n\n\ntwo   three')).toBe('one two three');
	});

	it('emits no markup, whatever it was given', () => {
		const flattened = excerpt('<script>alert(1)</script> [x](javascript:alert(1)) **b**');

		expect(flattened).not.toContain('<');
		expect(flattened).not.toContain('](');
	});

	it('cuts long bodies at a word, and says it cut', () => {
		const flattened = excerpt(`${'word '.repeat(80)}end`);

		expect(flattened.length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH + 1);
		expect(flattened.endsWith('…')).toBe(true);
		expect(flattened).not.toMatch(/wor…$/);
	});

	it('cuts mid-token when there is no word boundary worth using', () => {
		const flattened = excerpt('x'.repeat(400));

		expect(flattened).toBe(`${'x'.repeat(EXCERPT_MAX_LENGTH)}…`);
	});

	it('has nothing to say about an empty body', () => {
		expect(excerpt('   \n  ')).toBe('');
	});
});
