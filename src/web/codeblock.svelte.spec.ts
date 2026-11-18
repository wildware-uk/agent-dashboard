import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Markdown from './Markdown.svelte';
import { copyText, decorateBlock } from './codeblock';

/**
 * The header and the copy button, in a real browser (design §7).
 *
 * The owner: "for code blocks, I want a small header which says which language
 * it is, as well as a copy button top right." Both halves answer what somebody
 * actually does with code on a dashboard — find out what it is, then get it into
 * an editor.
 */

/**
 * How long to wait for colours to appear.
 *
 * The grammars are about a megabyte and are fetched lazily the first time a card
 * with code renders (`./highlight.ts`), so the wait here is a real network-shaped
 * one rather than a tick of the event loop. The default poll timeout is enough on
 * an idle machine and not enough on a busy one, which is a flaky test rather than
 * a slow one.
 */
const HIGHLIGHTER = { timeout: 15_000 };

/**
 * A `<pre><code>` in a container of its own, as the markdown renderer leaves one.
 *
 * The container matters: every spec here queries inside it rather than the whole
 * document, so a block left behind by an earlier test cannot answer.
 */
function aBlock(source: string): { pre: HTMLElement; host: HTMLElement } {
	const host = document.createElement('div');
	const pre = document.createElement('pre');
	const code = document.createElement('code');
	code.textContent = source;
	pre.append(code);
	host.append(pre);
	document.body.append(host);
	return { pre, host };
}

describe('the chrome around a block', () => {
	it('puts the language on the left and the button on the right', () => {
		const { pre, host } = aBlock('val x = 1');

		decorateBlock(pre, 'Kotlin');

		const header = host.querySelector('.code-block-header') as HTMLElement;
		expect(header.querySelector('.code-block-language')?.textContent).toBe('Kotlin');
		expect(header.querySelector('.code-block-copy')?.textContent).toBe('Copy');
		// The button is last in the header, which is what puts it on the right.
		expect(header.lastElementChild?.classList.contains('code-block-copy')).toBe(true);
	});

	it('keeps the block itself, rather than rebuilding it', () => {
		// Anything already holding a reference to the `pre` — the highlighter, a
		// spec — still has the same node afterwards.
		const { pre } = aBlock('val x = 1');

		const wrapper = decorateBlock(pre, 'Kotlin');

		expect(wrapper?.contains(pre)).toBe(true);
		expect(pre.querySelector('code')?.textContent).toBe('val x = 1');
	});

	it('does not stack a second header on a block it already did', () => {
		const { pre, host } = aBlock('val x = 1');

		decorateBlock(pre, 'Kotlin');
		const again = decorateBlock(pre, 'Kotlin');

		expect(again).toBeNull();
		expect(host.querySelectorAll('.code-block-header')).toHaveLength(1);
	});

	it('names the language to a screen reader, so several blocks are tellable apart', () => {
		const { pre, host } = aBlock('SELECT 1');

		decorateBlock(pre, 'SQL');

		expect(host.querySelector('.code-block-copy')?.getAttribute('aria-label')).toBe(
			'Copy the SQL code'
		);
	});
});

describe('copying', () => {
	it('puts the block`s source on the clipboard, not its markup', async () => {
		const written: string[] = [];
		vi.stubGlobal('navigator', {
			...navigator,
			clipboard: { writeText: async (text: string) => void written.push(text) }
		});

		const { pre, host } = aBlock('const a = 1;');
		// As the highlighter leaves it: spans around the tokens.
		pre.querySelector('code')!.innerHTML = '<span class="hljs-keyword">const</span> a = 1;';
		decorateBlock(pre, 'TypeScript');

		(host.querySelector('.code-block-copy') as HTMLButtonElement).click();
		await expect.poll(() => written.length).toBe(1);

		// What you paste is code, not HTML.
		expect(written[0]).toBe('const a = 1;');
		vi.unstubAllGlobals();
	});

	it('says so, and then goes back to offering', async () => {
		vi.stubGlobal('navigator', {
			...navigator,
			clipboard: { writeText: async () => {} }
		});

		const { pre, host } = aBlock('x');
		decorateBlock(pre, 'Text');
		const button = host.querySelector('.code-block-copy') as HTMLButtonElement;

		button.click();
		await expect.poll(() => button.textContent).toBe('Copied');
		await expect.poll(() => button.textContent, { timeout: 4_000 }).toBe('Copy');
		vi.unstubAllGlobals();
	});

	it('admits it when the clipboard is not available', async () => {
		// A dashboard reached over plain HTTP is not a secure context, and the old
		// way can be refused too. Saying nothing would be claiming success.
		vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
		vi.spyOn(document, 'execCommand').mockReturnValue(false);

		expect(await copyText('anything')).toBe(false);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
});

describe('a real markdown card', () => {
	it('grows a header naming the language the fence declared', async () => {
		const { container } = render(Markdown, {
			body: ['```kotlin', 'val marks = listOf("slack")', '```'].join('\n')
		});

		await expect
			.poll(() => container.querySelector('.code-block-language')?.textContent, HIGHLIGHTER)
			.toBe('Kotlin');
		expect(container.querySelector('.code-block-copy')).not.toBeNull();
	});

	it('says only "Code" for a bare fence, however sure the guess was', async () => {
		// Still coloured — the guess does that — but never named, because a header
		// is a statement and nobody made one.
		const { container } = render(Markdown, {
			body: ['```', 'SELECT id FROM media;', '```'].join('\n')
		});

		await expect
			.poll(() => container.querySelector('.code-block-language')?.textContent, HIGHLIGHTER)
			.toBe('Code');
		// Coloured all the same: which classes a guess produces is highlight.js's
		// business, but it produced some.
		expect(container.querySelectorAll('pre code span').length).toBeGreaterThan(0);
	});
});
