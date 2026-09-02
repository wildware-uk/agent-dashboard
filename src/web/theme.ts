/**
 * Per-project styling, turned into CSS custom properties (design §7).
 *
 * A project supplies at most two colours. Everything else the dashboard needs —
 * readable text, a muted text, a raised surface, a sunken one, a border — is
 * *derived* from the background rather than asked for, and that is the whole
 * design of this module.
 *
 * The reason is that the alternative does not work. Asking an owner (let alone
 * an agent) for seven colours produces six wrong ones: the failure mode of
 * user-set themes is always the same, dark text on a dark background, and it
 * arrives as "the dashboard is broken" rather than as "I picked a bad colour".
 * Deriving them means any background produces a legible page, and the worst
 * outcome available is a page somebody finds ugly.
 *
 * **The hex check here is not the security boundary but it is a real one.** The
 * domain refuses anything that is not a hex literal on the way in
 * (`src/domain/projects.ts`), and this refuses it again on the way out, because
 * this is the code that writes a string into a `style` attribute. Two checks for
 * one rule is worth it when the failure is arbitrary CSS on the owner's page.
 */
import type { ProjectTheme } from './types';

/** The same shape the domain enforces. Stated again because this emits CSS. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type Rgb = { r: number; g: number; b: number };

/** `#abc` and `#aabbcc` alike, or `null` for anything this must not emit. */
export function parseHex(value: string): Rgb | null {
	if (!HEX.test(value)) return null;

	const hex = value.slice(1);
	const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
	return {
		r: Number.parseInt(full.slice(0, 2), 16),
		g: Number.parseInt(full.slice(2, 4), 16),
		b: Number.parseInt(full.slice(4, 6), 16)
	};
}

function toHex({ r, g, b }: Rgb): string {
	const pair = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, '0');
	return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * Perceived brightness, 0 to 1 (WCAG relative luminance).
 *
 * Not the average of the channels: green carries most of what an eye reads as
 * brightness, and averaging is how a mid-green background ends up with black
 * text nobody can read.
 */
export function luminance(colour: Rgb): number {
	const channel = (value: number) => {
		const unit = value / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

/** Somewhere between two colours. `amount` 0 is the first, 1 is the second. */
function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return {
		r: from.r + (to.r - from.r) * amount,
		g: from.g + (to.g - from.g) * amount,
		b: from.b + (to.b - from.b) * amount
	};
}

/** Not pure white or pure black: both are harsher than any real interface uses. */
const LIGHT_INK: Rgb = { r: 246, g: 248, b: 250 };
const DARK_INK: Rgb = { r: 22, g: 26, b: 33 };

/** WCAG contrast between two colours, 1 (identical) to 21 (black on white). */
export function contrast(one: Rgb, other: Rgb): number {
	const a = luminance(one);
	const b = luminance(other);
	const [lighter, darker] = a > b ? [a, b] : [b, a];
	return (lighter + 0.05) / (darker + 0.05);
}

/** Body text needs this much contrast against what it sits on (WCAG AA). */
export const AA_CONTRAST = 4.5;

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * The text colour a background can carry: whichever reads better on it.
 *
 * Measured rather than decided by a lightness threshold, because the two inks
 * are not symmetric and a threshold gets mid-tones wrong in exactly the range
 * where it matters most.
 *
 * The softened inks are used when they clear AA, and pure white or black when
 * they do not — an interface reads better in #f6f8fa than in #ffffff, but not at
 * the cost of legibility. One case cannot be won at all: a mid grey page has no
 * text colour that reaches 4.5:1 against it, and there this returns the best
 * available rather than pretending. That is a colour the owner chose, and the
 * honest response is the most readable page it admits of.
 */
export function ink(background: Rgb): Rgb {
	const soft =
		contrast(background, LIGHT_INK) >= contrast(background, DARK_INK) ? LIGHT_INK : DARK_INK;
	if (contrast(background, soft) >= AA_CONTRAST) return soft;

	const pure = contrast(background, WHITE) >= contrast(background, BLACK) ? WHITE : BLACK;
	return contrast(background, pure) > contrast(background, soft) ? pure : soft;
}

/**
 * A visible step away from a colour, in the direction asked for.
 *
 * The fallback is what makes the extremes work: `#fafafa` cannot go 8% lighter
 * in a way that survives rounding to a byte, and `#000000` cannot go darker at
 * all. In both cases the step goes the other way instead, because a card that is
 * *distinguishable* from the page is the point — which side it falls on matters
 * less than that it does.
 */
function step(from: Rgb, toward: Rgb, amount: number, fallback: Rgb): Rgb {
	const moved = mix(from, toward, amount);
	if (toHex(moved) !== toHex(from)) return moved;

	// A near-white page cannot go 8% lighter in a way that survives rounding to a
	// byte, but it can still go all the way to white — which is exactly what the
	// dashboard's own light theme does for its raised surface.
	if (toHex(toward) !== toHex(from)) return toward;

	// Already at the extreme: step the other way instead, because a card that is
	// distinguishable from the page is the point and which side it falls on
	// matters less than that it does.
	return mix(from, fallback, amount);
}

/** The tokens a themed region overrides. Everything else is inherited. */
export type ThemeTokens = Record<string, string>;

/**
 * Set one surface, under both names Tailwind can be reading it by.
 *
 * `app.css` declares `--color-surface: var(--surface)` inside `@theme`, which
 * puts that mapping on `:root` — and a custom property's `var()` is substituted
 * where it is *declared*, not where it is used. So a descendant that overrides
 * `--surface` alone changes nothing: `--color-surface` was already resolved
 * against the root's value and inherits down as a finished colour.
 *
 * This cost a shipped feature that did nothing, and a test that asserted the
 * property was set rather than that anything read it. Both names are written
 * now, and `theme.svelte.spec.ts` checks a rendered element's computed
 * background rather than the attribute.
 */
function set(tokens: ThemeTokens, name: string, value: string): void {
	tokens[`--${name}`] = value;
	tokens[`--color-${name}`] = value;
}

/**
 * The custom properties for one project's theme.
 *
 * An empty object for a project with no theme, or one whose colours this
 * refuses — in both cases the page keeps the dashboard's own styling, which is
 * always readable.
 */
export function themeTokens(theme: ProjectTheme | null | undefined): ThemeTokens {
	const tokens: ThemeTokens = {};
	if (!theme) return tokens;

	const background = theme.background ? parseHex(theme.background) : null;
	if (background) {
		const text = ink(background);

		set(tokens, 'surface', toHex(background));
		// Raised is lighter and sunken darker, matching how the dashboard's own two
		// themes are built (`app.css`) — so a card lifts off the page the same way
		// whatever colour the page is.
		set(tokens, 'surface-raised', toHex(step(background, WHITE, 0.08, BLACK)));
		set(tokens, 'surface-sunken', toHex(step(background, BLACK, 0.06, WHITE)));
		set(tokens, 'border-subtle', toHex(mix(background, text, 0.22)));
		set(tokens, 'content', toHex(text));
		set(tokens, 'content-muted', toHex(mix(background, text, 0.62)));
	}

	const accent = theme.accent ? parseHex(theme.accent) : null;
	if (accent) set(tokens, 'accent', toHex(accent));

	return tokens;
}

/**
 * The same tokens as a `style` attribute value.
 *
 * Built from {@link themeTokens} rather than from the theme, so the hex check is
 * upstream of every string that reaches an attribute and there is no second path
 * into one.
 */
export function themeStyle(theme: ProjectTheme | null | undefined): string {
	return Object.entries(themeTokens(theme))
		.map(([token, value]) => `${token}: ${value}`)
		.join('; ');
}
