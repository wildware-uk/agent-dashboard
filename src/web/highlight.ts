/**
 * Colouring the code in an agent's markdown (design §7, §8).
 *
 * The owner asked for syntax highlighting across "all modern programming
 * languages". highlight.js carries 193 of them, and the interesting decisions
 * here are about *when* it arrives and *what* it is allowed to see.
 *
 * ## It is loaded only when there is code on the page
 *
 * The full grammar set is about a megabyte, and most of what the dashboard shows
 * is prose. So it is a dynamic import, taken the first time a card with a fenced
 * block renders and cached for the life of the tab: the first paint costs
 * nothing, the code appears immediately in plain monospace, and the colours
 * arrive a moment later. A timeline of pure text never pays for it at all.
 *
 * ## It only ever sees text
 *
 * `renderMarkdown` escapes every raw tag rather than sanitising (`./markdown.ts`)
 * — that is the whole security model of the timeline, and highlighting must not
 * put a hole in it. So this reads `textContent` from the block, which is the
 * decoded source and cannot contain markup, hands *that* to highlight.js, and
 * writes back the escaped HTML it returns. At no point is a string from an agent
 * treated as markup: the round trip goes escaped → text → escaped, and a `<img
 * onerror>` in a code fence comes out as the characters somebody typed.
 *
 * `ignoreIllegals` is on because a grammar that refuses a snippet should give
 * back plain code, not throw: half the code on a dashboard is a fragment, and a
 * fragment that fails to parse is still worth reading.
 */

import { decorateBlock, labelFor } from './codeblock';

/** What markdown-it puts in front of a fence's language (`langPrefix`). */
const LANGUAGE_CLASS = 'language-';

/** The type we use from highlight.js, named so nothing here imports it eagerly. */
type Highlighter = {
	getLanguage: (name: string) => { name?: string } | undefined;
	highlight: (
		code: string,
		options: { language: string; ignoreIllegals?: boolean }
	) => { value: string; language?: string; relevance?: number };
	highlightAuto: (code: string) => { value: string; language?: string; relevance?: number };
	listLanguages: () => string[];
};

/**
 * The language a block declares, or `null` for a bare fence.
 *
 * Only the first `language-` class is read, and only the token after the prefix:
 * markdown-it writes the fence's info string there verbatim, so this is the one
 * place an agent's word reaches a lookup — and all it can do is fail to match a
 * grammar.
 */
export function languageFrom(className: string): string | null {
	for (const name of className.split(/\s+/)) {
		if (name.startsWith(LANGUAGE_CLASS)) {
			const language = name.slice(LANGUAGE_CLASS.length).trim().toLowerCase();
			return language === '' ? null : language;
		}
	}
	return null;
}

/**
 * What a language name may look like before it is allowed near a class attribute.
 *
 * Narrow on purpose. Every real grammar name is letters, digits and a little
 * punctuation — `c++`, `objective-c`, `f#` — and the reason to be strict is that
 * this string comes from an agent and ends up in `class`. Svelte escapes the
 * attribute, so nothing can break out of it, but a name with a space in it would
 * add a *second* class: `hidden`, or a Tailwind utility like `fixed`, and an
 * agent that could name one could move things around the owner's page.
 */
const SAFE_LANGUAGE = /^[a-z0-9+#._-]{1,32}$/;

/**
 * The class that marks a block's language, or `''` for anything unusable.
 *
 * The one place a language reaches markup, so the check lives here rather than
 * at each call site.
 */
export function languageClass(language: string | null | undefined): string {
	if (!language) return '';
	const name = language.trim().toLowerCase();
	return SAFE_LANGUAGE.test(name) ? `${LANGUAGE_CLASS}${name}` : '';
}

let loading: Promise<Highlighter | null> | undefined;

/**
 * The highlighter, loaded once per tab.
 *
 * `null` when the import fails — an offline deployment, a chunk that did not
 * ship — because plain monospace code is a perfectly good outcome and a
 * dashboard that threw over syntax colours would be a worse product than one
 * that quietly does without them.
 */
export function loadHighlighter(): Promise<Highlighter | null> {
	loading ??= import('highlight.js')
		.then((module) => (module.default ?? module) as unknown as Highlighter)
		.catch(() => null);
	return loading;
}

/** Test seam: forget the cached load so a spec can stub it. */
export function resetHighlighter(): void {
	loading = undefined;
}

/**
 * Colour one block, in place.
 *
 * `data-highlighted` makes this idempotent, which matters because the component
 * re-runs whenever its body changes: without it, a card that re-rendered would
 * feed already-marked-up HTML back through `textContent` and slowly eat its own
 * spans.
 */
export function highlightBlock(
	hljs: Highlighter,
	code: HTMLElement
): { declared: string | null; detected: string | null; relevance: number } | null {
	if (code.dataset.highlighted === 'yes') return null;

	const source = code.textContent ?? '';
	if (source.trim() === '') return null;

	const declared = languageFrom(code.className);
	// A declared language we have no grammar for is treated as no language at
	// all rather than as an error: `sh` and `shell` both work, and `pseudocode`
	// still gets a reasonable guess.
	const language = declared && hljs.getLanguage(declared) ? declared : null;

	const highlighted = language
		? hljs.highlight(source, { language, ignoreIllegals: true })
		: hljs.highlightAuto(source);

	// The only assignment of markup in this module, and its input is the
	// highlighter's own escaped output — never the page's existing HTML.
	code.innerHTML = highlighted.value;
	code.dataset.highlighted = 'yes';
	code.classList.add('hljs');

	// What the header will say. Only what the author declared: the guess colours
	// the block but never names it (`./codeblock.ts`).
	return {
		declared,
		detected: highlighted.language ?? null,
		relevance: highlighted.relevance ?? 0
	};
}

/**
 * Colour every fenced block inside one element.
 *
 * Resolves when they are all done, so a spec can await it. Does nothing at all
 * when there is no code, which is what keeps the highlighter off the wire for a
 * timeline of prose.
 */
export async function highlightIn(root: ParentNode | null | undefined): Promise<void> {
	if (!root) return;

	const blocks = [...root.querySelectorAll<HTMLElement>('pre code')].filter(
		(code) => code.dataset.highlighted !== 'yes'
	);
	if (blocks.length === 0) return;

	const hljs = await loadHighlighter();
	if (!hljs) return;

	for (const code of blocks) {
		const language = highlightBlock(hljs, code);
		const pre = code.closest('pre');
		if (!language || !pre) continue;

		// The header and the copy button (`./codeblock.ts`). After highlighting
		// rather than before, because a bare fence's language is only known once
		// the guess has been made.
		decorateBlock(
			pre,
			labelFor(language.declared, (name) => hljs.getLanguage(name)?.name)
		);
	}
}
