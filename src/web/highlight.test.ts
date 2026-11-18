import { describe, expect, it } from 'vitest';
import { languageClass, languageFrom } from './highlight';

/**
 * Colouring code (design §7, §8).
 *
 * The two decisions here that are not about colour: which language a block
 * declares, and whether that word is allowed anywhere near a class attribute.
 * Both are pure, so they are asserted on strings. What the highlighter is
 * allowed to *see* is asserted in a real browser, in `highlight.svelte.spec.ts`.
 */

describe('reading the language off a block', () => {
	it('takes the one markdown-it wrote', () => {
		expect(languageFrom('language-typescript')).toBe('typescript');
		expect(languageFrom('hljs language-Rust something')).toBe('rust');
	});

	it('is nothing for a bare fence', () => {
		expect(languageFrom('')).toBeNull();
		expect(languageFrom('hljs')).toBeNull();
		expect(languageFrom('language-')).toBeNull();
	});
});

describe('putting a language into a class', () => {
	it('passes the names real grammars have', () => {
		for (const name of ['ts', 'c++', 'objective-c', 'f#', 'php-template']) {
			expect(languageClass(name), name).toBe(`language-${name}`);
		}
	});

	it('refuses anything that would add a second class', () => {
		// The reason this function exists. Svelte escapes the attribute, so nothing
		// can break out of it — but a name with a space in it would put another
		// class on the element, and an agent that could name one could hide things
		// on the owner's page or pin them over it.
		for (const name of ['ts hidden', 'x fixed inset-0', 'a b', '  ']) {
			expect(languageClass(name), JSON.stringify(name)).toBe('');
		}
	});

	it('is empty for nothing at all', () => {
		expect(languageClass(null)).toBe('');
		expect(languageClass(undefined)).toBe('');
	});
});
