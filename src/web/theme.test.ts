import { describe, expect, it } from 'vitest';
import { AA_CONTRAST, contrast, ink, luminance, parseHex, themeStyle, themeTokens } from './theme';

/**
 * Per-project styling (design §7).
 *
 * The property being pinned is the one that makes user-set themes survivable:
 * whatever background is chosen, the text derived for it is readable. The rest
 * is the hex check, restated here because this module writes a `style`
 * attribute.
 */
describe('parseHex', () => {
	it('reads both lengths', () => {
		expect(parseHex('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseHex('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
	});

	it('refuses everything that is not a hex literal', () => {
		for (const value of ['red', 'var(--surface)', 'url(x)', '#ff', 'rgb(1,2,3)', '#12345g']) {
			expect(parseHex(value), value).toBeNull();
		}
	});
});

describe('choosing text for a background', () => {
	it('puts light text on a dark page', () => {
		expect(luminance(parseHex('#101820')!)).toBeLessThan(0.1);
		expect(ink(parseHex('#101820')!).r).toBeGreaterThan(200);
	});

	it('puts dark text on a light page', () => {
		expect(ink(parseHex('#fdfdfd')!).r).toBeLessThan(60);
	});

	it('reads brightness the way an eye does, not by averaging channels', () => {
		// Same channel average, wildly different perceived brightness: green reads
		// far brighter than blue, and averaging is how a mid-green page ends up
		// with unreadable text.
		expect(luminance(parseHex('#00ff00')!)).toBeGreaterThan(luminance(parseHex('#0000ff')!));
		expect(ink(parseHex('#00ff00')!).r).toBeLessThan(60);
		expect(ink(parseHex('#0000ff')!).r).toBeGreaterThan(200);
	});

	it('clears WCAG AA on every background that admits of it', () => {
		const readable = (background: string) =>
			contrast(parseHex(background)!, ink(parseHex(background)!));

		for (const background of [
			'#000000',
			'#ffffff',
			'#101820',
			'#ff0000',
			'#00ff00',
			'#0000ff',
			'#ffb300',
			'#4b0082',
			'#fafafa',
			'#7f7f7f'
		]) {
			expect(readable(background), background).toBeGreaterThanOrEqual(AA_CONTRAST);
		}
	});

	it('reaches for pure ink only when the softened one falls short', () => {
		// The softened inks read better and are used wherever they clear AA. A mid
		// grey is the case that needs the extra contrast pure black buys.
		expect(ink(parseHex('#101820')!)).toEqual({ r: 246, g: 248, b: 250 });
		expect(ink(parseHex('#7f7f7f')!)).toEqual({ r: 0, g: 0, b: 0 });
	});
});

describe('themeTokens', () => {
	it('derives a whole palette from one background', () => {
		const tokens = themeTokens({ background: '#101820' });

		expect(tokens['--surface']).toBe('#101820');
		expect(tokens['--surface-raised']).not.toBe(tokens['--surface']);
		expect(tokens['--surface-sunken']).not.toBe(tokens['--surface']);
		expect(tokens['--content']).toBeDefined();
		expect(tokens['--content-muted']).toBeDefined();
		expect(tokens['--border-subtle']).toBeDefined();
	});

	it('lifts a card off the page and sinks a well into it, either way round', () => {
		for (const background of ['#101820', '#fafafa']) {
			const tokens = themeTokens({ background });
			const page = luminance(parseHex(tokens['--surface'])!);

			expect(luminance(parseHex(tokens['--surface-raised'])!), background).toBeGreaterThan(page);
			expect(luminance(parseHex(tokens['--surface-sunken'])!), background).toBeLessThan(page);
		}
	});

	it('takes an accent on its own, without touching the page', () => {
		expect(themeTokens({ accent: '#ffb300' })).toEqual({
			'--accent': '#ffb300',
			'--color-accent': '#ffb300'
		});
	});

	it('writes both names, because Tailwind reads the --color- one', () => {
		// `app.css` maps `--color-surface: var(--surface)` on `:root`, and that
		// var() resolves where it is declared — so overriding `--surface` alone
		// changes nothing further down the tree. This is the bug that shipped.
		const tokens = themeTokens({ background: '#101820' });

		expect(tokens['--surface']).toBe('#101820');
		expect(tokens['--color-surface']).toBe('#101820');
	});

	it('normalises shorthand on the way out', () => {
		expect(themeTokens({ accent: '#f0a' })['--color-accent']).toBe('#ff00aa');
	});

	it('emits nothing for a project with no theme', () => {
		expect(themeTokens(null)).toEqual({});
		expect(themeTokens(undefined)).toEqual({});
		expect(themeTokens({})).toEqual({});
	});

	it('ignores a colour it cannot verify rather than emitting it', () => {
		// The server refuses these on the way in; this is the second check, and it
		// is the one standing between an API response and a style attribute.
		expect(themeTokens({ background: 'red', accent: 'var(--x)' })).toEqual({});
	});

	it('keeps the good half of a half-broken theme', () => {
		expect(themeTokens({ background: '#101820', accent: 'javascript:1' })['--surface']).toBe(
			'#101820'
		);
		expect(
			themeTokens({ background: '#101820', accent: 'javascript:1' })['--accent']
		).toBeUndefined();
	});
});

describe('themeStyle', () => {
	it('writes declarations a style attribute takes', () => {
		expect(themeStyle({ accent: '#ffb300' })).toBe('--accent: #ffb300; --color-accent: #ffb300');
	});

	it('is empty for an unthemed project, so the attribute does nothing', () => {
		expect(themeStyle(null)).toBe('');
	});

	it('can never emit anything but tokens and hex', () => {
		const style = themeStyle({
			background: '#101820; position: fixed',
			accent: '#fff}html{display:none'
		});

		expect(style).toBe('');
	});
});
