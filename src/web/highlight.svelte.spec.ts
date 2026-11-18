import { describe, expect, it, vi } from 'vitest';
import { highlightBlock, highlightIn } from './highlight';

/**
 * Colouring code, in a real browser (design §7, §8).
 *
 * The assertion that matters is not that code is pretty. It is that the
 * highlighter only ever sees *text*: `renderMarkdown` escapes every raw tag
 * rather than sanitising, and putting colours on the result must not open a way
 * back. The round trip goes escaped → `textContent` → escaped, so a tag inside a
 * code fence stays the characters somebody typed.
 */

/** A stand-in for highlight.js that records what it was asked to colour. */
function fakeHighlighter(known: string[] = ['typescript']) {
	return {
		getLanguage: (name: string) => (known.includes(name) ? {} : undefined),
		highlight: vi.fn((code: string, options: { language: string }) => ({
			value: `<span class="hljs-keyword">${options.language}</span>${code.length}`
		})),
		highlightAuto: vi.fn((code: string) => ({ value: `auto:${code.length}` })),
		listLanguages: () => known
	};
}

/** A `<pre><code>` as `renderMarkdown` writes one. */
function aBlock(source: string, language?: string): HTMLElement {
	const pre = document.createElement('pre');
	const code = document.createElement('code');
	if (language) code.className = `language-${language}`;
	code.textContent = source;
	pre.append(code);
	document.body.append(pre);
	return code;
}

describe('colouring one block', () => {
	it('uses the declared grammar when there is one', () => {
		const hljs = fakeHighlighter();
		const code = aBlock('const a = 1;', 'typescript');

		highlightBlock(hljs, code);

		expect(hljs.highlight).toHaveBeenCalledWith('const a = 1;', {
			language: 'typescript',
			ignoreIllegals: true
		});
		expect(code.classList.contains('hljs')).toBe(true);
	});

	it('guesses when the fence named a language we have no grammar for', () => {
		// `pseudocode` is not a grammar, and refusing to colour it would be worse
		// than guessing: the point is that the code is readable.
		const hljs = fakeHighlighter();
		const code = aBlock('x := 1', 'pseudocode');

		highlightBlock(hljs, code);

		expect(hljs.highlightAuto).toHaveBeenCalled();
		expect(hljs.highlight).not.toHaveBeenCalled();
	});

	it('hands over the source as text, never as markup', () => {
		// The security assertion. `renderMarkdown` escaped this on the way in, the
		// DOM decoded it, and what the highlighter sees is the characters somebody
		// typed — so a tag in a code fence can never become an element.
		const hljs = fakeHighlighter();
		const code = aBlock('<img src=x onerror=alert(1)>');

		highlightBlock(hljs, code);

		expect(hljs.highlightAuto).toHaveBeenCalledWith('<img src=x onerror=alert(1)>');
		expect(code.querySelector('img')).toBeNull();
	});

	it('leaves a block it has already done alone', () => {
		// Without this a card that re-rendered would feed its own spans back
		// through `textContent` and slowly eat them.
		const hljs = fakeHighlighter();
		const code = aBlock('const a = 1;', 'typescript');

		highlightBlock(hljs, code);
		highlightBlock(hljs, code);

		expect(hljs.highlight).toHaveBeenCalledTimes(1);
	});

	it('ignores an empty block rather than colouring nothing', () => {
		const hljs = fakeHighlighter();
		const code = aBlock('   ');

		highlightBlock(hljs, code);

		expect(hljs.highlight).not.toHaveBeenCalled();
		expect(hljs.highlightAuto).not.toHaveBeenCalled();
	});
});

describe('colouring a card', () => {
	it('does not reach for the highlighter when there is no code', async () => {
		// A megabyte of grammars, fetched only when something needs them: a
		// timeline of prose never pays for it.
		const empty = document.createElement('div');
		empty.innerHTML = '<p>no code here</p>';

		await expect(highlightIn(empty)).resolves.toBeUndefined();
	});

	it('does nothing for an element that is not there', async () => {
		await expect(highlightIn(null)).resolves.toBeUndefined();
	});
});
