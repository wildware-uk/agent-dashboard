// The app's real stylesheet: this suite exists to check that Tailwind's own
// utilities pick the theme up, which is exactly what a unit test of the token
// map cannot see.
import '../http/routes/app.css';
import { describe, expect, it } from 'vitest';
import { themeStyle } from './theme';

/**
 * A project's theme, as the browser actually resolves it (design §7).
 *
 * `theme.test.ts` covers what the token map contains. This covers the thing that
 * shipped broken anyway: whether a `bg-surface` element inside a themed subtree
 * is actually painted in the project's colour.
 *
 * The bug it pins: `app.css` declares `--color-surface: var(--surface)` inside
 * `@theme`, which lands on `:root`. A custom property's `var()` is substituted
 * where it is declared, so overriding `--surface` on a descendant left
 * `--color-surface` still resolved against the root — and `bg-surface` reads the
 * `--color-` one. Every assertion here is on a computed colour for that reason.
 */
function paint(style: string, classes: string): CSSStyleDeclaration {
	document.body.innerHTML = `<div style="${style}"><span id="probe" class="${classes}">x</span></div>`;
	return getComputedStyle(document.getElementById('probe')!);
}

describe('a themed subtree', () => {
	it('paints bg-surface in the project’s background', () => {
		const computed = paint(themeStyle({ background: '#101820' }), 'bg-surface');

		expect(computed.backgroundColor).toBe('rgb(16, 24, 32)');
	});

	it('paints a card’s bg-surface-raised in the derived raised colour', () => {
		const computed = paint(themeStyle({ background: '#101820' }), 'bg-surface-raised');

		expect(computed.backgroundColor).not.toBe('rgb(16, 24, 32)');
		expect(computed.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
	});

	it('paints text-content in an ink readable on that background', () => {
		const computed = paint(themeStyle({ background: '#101820' }), 'text-content');

		// Light ink on a dark page, derived rather than asked for.
		expect(computed.color).toBe('rgb(246, 248, 250)');
	});

	it('paints text-content dark on a light page', () => {
		const computed = paint(themeStyle({ background: '#fdfdfd' }), 'text-content');

		expect(computed.color).toBe('rgb(22, 26, 33)');
	});

	it('paints bg-accent in the project’s accent', () => {
		const computed = paint(themeStyle({ accent: '#ffb300' }), 'bg-accent');

		expect(computed.backgroundColor).toBe('rgb(255, 179, 0)');
	});

	it('leaves an unthemed subtree on the dashboard’s own colours', () => {
		const themed = paint(themeStyle({ background: '#101820' }), 'bg-surface').backgroundColor;
		const plain = paint(themeStyle(null), 'bg-surface').backgroundColor;

		expect(plain).not.toBe(themed);
		expect(plain).not.toBe('rgba(0, 0, 0, 0)');
	});
});
