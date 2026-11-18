import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Markdown from './Markdown.svelte';

/**
 * Agent-authored markdown, with its code coloured (design §7, §8).
 *
 * The owner asked for syntax highlighting across "all modern programming
 * languages". These use the real highlighter rather than a stand-in, because the
 * thing worth proving is that the grammars are actually reachable from the page
 * — a lazily imported megabyte that never arrives would pass every unit test.
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

/** Wait for the highlighter's dynamic import and the effect that follows it. */
async function coloured(selector = 'pre code.hljs') {
	await expect.poll(() => document.querySelector(selector) !== null, HIGHLIGHTER).toBe(true);
	return document.querySelector(selector) as HTMLElement;
}

describe('a fenced code block', () => {
	it('is coloured with the grammar the fence named', async () => {
		render(Markdown, {
			body: ['```ts', 'const answer: number = 42;', '```'].join('\n')
		});

		const code = await coloured();
		expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
		expect(code.textContent).toContain('const answer: number = 42;');
	});

	it('colours a language nobody would have hardcoded', async () => {
		// "All modern programming languages" is the ask, so the test picks one
		// nobody would have put in a shortlist.
		render(Markdown, {
			body: ['```elixir', 'defmodule Greeter do', 'end', '```'].join('\n')
		});

		const code = await coloured();
		expect(code.querySelectorAll('span').length).toBeGreaterThan(0);
		expect(code.textContent).toContain('defmodule Greeter do');
	});

	it('guesses for a bare fence rather than leaving it grey', async () => {
		render(Markdown, { body: ['```', 'SELECT * FROM media WHERE id = 1;', '```'].join('\n') });

		const code = await coloured();
		expect(code.querySelectorAll('span').length).toBeGreaterThan(0);
	});

	it('renders a tag in a fence as text, never as an element', async () => {
		// The line the whole markdown pipeline holds: escaped on the way in, and
		// the highlighter only ever sees the decoded characters.
		render(Markdown, {
			body: ['```html', '<img src=x onerror="alert(1)">', '```'].join('\n')
		});

		const code = await coloured();
		expect(code.querySelector('img')).toBeNull();
		expect(code.textContent).toContain('<img src=x onerror="alert(1)">');
	});

	it('leaves prose alone', async () => {
		const screen = render(Markdown, { body: 'Just **words**, no code.' });

		await expect.element(screen.getByText('words')).toBeInTheDocument();
		expect(document.querySelector('pre')).toBeNull();
	});
});
