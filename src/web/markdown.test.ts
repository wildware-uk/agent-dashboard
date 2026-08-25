import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

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
