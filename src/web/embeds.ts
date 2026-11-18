/**
 * The pure decisions behind an embed (migration 027).
 *
 * An embed is two things joined at render time: a **look** — which blocks to
 * draw, in what colours — and the **values** one instance carries. Everything
 * here is a function of those two, with no DOM and no store, so the interesting
 * rules can be asserted on data in `embeds.test.ts` rather than on pixels.
 *
 * Three of those rules are the feature:
 *
 * **A block whose values all come out empty is not drawn.** That is what lets
 * one look cover a Slack message with reactions on it and one without, and it is
 * why {@link resolveBlocks} returns a shorter list than the spec rather than a
 * list with holes in it. Literal text in a block counts as a value — a footer
 * that says "View in Slack" is not empty just because the URL beside it is.
 *
 * **The palette becomes CSS custom properties, and nothing else.** Colours
 * arrive from an agent, so the server has already refused anything that is not a
 * hex literal (`$domain/embeds.ts`); this puts them in a `style` attribute as
 * `--embed-*` values that the component's own classes read. No agent string ever
 * becomes a class name or a bare declaration.
 *
 * **Where it came from is a value like any other.** An embed's `source_url` is
 * offered to the look as `{{source_url}}`, so a spec can put it in a footer, and
 * it also makes the badge along the top a link — which is what stops a poster
 * that said where it came from from having said it into a column nobody reads.
 *
 * **A picture is either an upload or an https URL.** An uploaded media id is the
 * private path and the preferred one; an https URL is allowed because an agent
 * quoting somebody's Slack avatar has one and not the other. Anything else —
 * `javascript:`, `data:`, a relative path — resolves to nothing rather than to a
 * broken or dangerous `src`.
 */
import { mediaUrl } from './media';
import type {
	EmbedBlock,
	EmbedData,
	EmbedFrame,
	EmbedMark,
	EmbedRadius,
	EmbedSize,
	EmbedSpec,
	EmbedTheme
} from './types';

/** A ULID, which is what an uploaded media id looks like. */
const MEDIA_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `{{name}}`, with any blanks inside the braces forgiven. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/** The corner each radius means, as a CSS length. */
const RADII: Record<EmbedRadius, string> = {
	none: '0',
	sm: '0.25rem',
	md: '0.5rem',
	lg: '0.875rem'
};

/**
 * One value from an instance, as text.
 *
 * A list joins with commas, because the one block that wants a list — `chips` —
 * splits it again, and every other block wants a sentence.
 */
function valueOf(data: EmbedData, name: string): string {
	const value = data[name];
	if (value === undefined) return '';
	return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Put the instance's values into one of the look's strings.
 *
 * @returns the filled string, and whether any placeholder in it actually found
 *   something. That second answer is what {@link resolveBlocks} drops a block
 *   on: a string with no placeholders at all is literal text and always counts.
 */
export function fill(template: string, data: EmbedData): { text: string; filled: boolean } {
	let sawPlaceholder = false;
	let filled = false;

	const text = template.replace(PLACEHOLDER, (_, name: string) => {
		sawPlaceholder = true;
		const value = valueOf(data, name);
		if (value !== '') filled = true;
		return value;
	});

	return { text: text.trim(), filled: !sawPlaceholder || filled };
}

/**
 * The instance's values, with the one this module supplies itself.
 *
 * `source_url` is a column rather than a value the poster typed, but a look has
 * no way to reach a column — so it is offered under that name, and only when the
 * poster did not send a value of their own by it.
 */
export function withSource(data: EmbedData, sourceUrl: string | null): EmbedData {
	if (!sourceUrl || data.source_url !== undefined) return data;
	return { ...data, source_url: sourceUrl };
}

/** {@link fill}, for a field that may be absent from the spec entirely. */
function fillOptional(
	template: string | undefined,
	data: EmbedData
): { text: string; filled: boolean } {
	if (template === undefined) return { text: '', filled: false };
	return fill(template, data);
}

/**
 * The look's blocks with the instance's values in them, minus the ones that came
 * out empty.
 *
 * A `divider` has no values and is never dropped on its own — but a divider that
 * ends up first or last, or next to another one, is dropped, because a rule
 * separating nothing from nothing is a line across an empty card.
 */
export function resolveBlocks(spec: EmbedSpec, data: EmbedData): EmbedBlock[] {
	const resolved: EmbedBlock[] = [];

	for (const block of spec.blocks) {
		const drawn = resolveBlock(block, data);
		if (drawn) resolved.push(drawn);
	}

	return trimDividers(resolved);
}

function resolveBlock(block: EmbedBlock, data: EmbedData): EmbedBlock | undefined {
	switch (block.type) {
		case 'divider':
			return block;

		case 'header': {
			const avatar = fillOptional(block.avatar, data);
			const title = fillOptional(block.title, data);
			const subtitle = fillOptional(block.subtitle, data);
			const meta = fillOptional(block.meta, data);
			// A header with nothing but an avatar is a floating picture; a header
			// with any words in it is a header.
			if (title.text === '' && subtitle.text === '' && meta.text === '') return undefined;
			return {
				type: 'header',
				...(avatar.text ? { avatar: avatar.text } : {}),
				...(title.text ? { title: title.text } : {}),
				...(subtitle.text ? { subtitle: subtitle.text } : {}),
				...(meta.text ? { meta: meta.text } : {}),
				// Presentation, carried through untouched: it came from the look, not
				// from the instance, so there is nothing in it to fill in.
				...(block.shape ? { shape: block.shape } : {}),
				...(block.size ? { size: block.size } : {}),
				...(block.layout ? { layout: block.layout } : {}),
				...(block.bar ? { bar: true } : {})
			};
		}

		case 'fields': {
			const items = block.items
				.map((item) => ({
					label: fill(item.label, data),
					value: fill(item.value, data)
				}))
				// A row whose value did not arrive is a row saying "Assignee —",
				// which is worse than no row.
				.filter((item) => item.value.filled && item.value.text !== '')
				.map((item) => ({ label: item.label.text, value: item.value.text }));
			if (items.length === 0) return undefined;
			return { type: 'fields', items, ...(block.layout ? { layout: block.layout } : {}) };
		}

		case 'footer': {
			const value = fillOptional(block.value, data);
			const url = fillOptional(block.url, data);
			const href = link(url.text);
			// A footer is a link, a line of text, or nothing.
			if (value.text === '' && !href) return undefined;
			return {
				type: 'footer',
				...(value.text ? { value: value.text } : {}),
				...(href ? { url: href } : {})
			};
		}

		case 'image': {
			const value = fill(block.value, data);
			const alt = fillOptional(block.alt, data);
			if (!value.filled || imageSrc(value.text) === null) return undefined;
			return { type: 'image', value: value.text, ...(alt.text ? { alt: alt.text } : {}) };
		}

		case 'code': {
			const value = fill(block.value, data);
			const language = fillOptional(block.language, data);
			if (!value.filled || value.text === '') return undefined;
			return {
				type: 'code',
				value: value.text,
				...(language.text ? { language: language.text } : {})
			};
		}

		case 'heading': {
			const value = fill(block.value, data);
			if (!value.filled || value.text === '') return undefined;
			return { type: 'heading', value: value.text, level: block.level ?? 1 };
		}

		case 'text': {
			const value = fill(block.value, data);
			if (!value.filled || value.text === '') return undefined;
			return {
				type: 'text',
				value: value.text,
				...(block.tone ? { tone: block.tone } : {}),
				...(block.size ? { size: block.size } : {})
			};
		}

		case 'markdown': {
			const value = fill(block.value, data);
			if (!value.filled || value.text === '') return undefined;
			return { type: 'markdown', value: value.text, ...(block.size ? { size: block.size } : {}) };
		}

		case 'chips': {
			const value = fill(block.value, data);
			if (!value.filled || value.text === '') return undefined;
			return { type: 'chips', value: value.text, ...(block.style ? { style: block.style } : {}) };
		}

		default: {
			const value = fill(block.value, data);
			if (!value.filled || value.text === '') return undefined;
			return { type: block.type, value: value.text };
		}
	}
}

/** Drop a rule that separates nothing: leading, trailing, or doubled. */
function trimDividers(blocks: readonly EmbedBlock[]): EmbedBlock[] {
	const kept: EmbedBlock[] = [];

	for (const block of blocks) {
		if (block.type !== 'divider') {
			kept.push(block);
			continue;
		}
		if (kept.length === 0) continue;
		if (kept[kept.length - 1].type === 'divider') continue;
		kept.push(block);
	}

	while (kept.length > 0 && kept[kept.length - 1].type === 'divider') kept.pop();

	return kept;
}

/** The badge along the top, with the instance's values in it. */
export function resolveChrome(
	spec: EmbedSpec,
	data: EmbedData
): { label: string; icon: string } | null {
	const label = fillOptional(spec.chrome.label, data);
	const icon = fillOptional(spec.chrome.icon, data);
	if (label.text === '' && icon.text === '') return null;
	return { label: label.text, icon: icon.text };
}

/**
 * The source's mark, and what to call it (migration 029).
 *
 * Separate from {@link resolveChrome} because it is a different thing in a
 * different place: the badge is a labelled bar a look may or may not want, and
 * the mark is the small corner glyph that says where a card came from. A look
 * with no badge at all still gets one, which is the whole point — the built-in
 * Slack look carries no "Slack" bar and still has to be recognisable as Slack.
 *
 * `image` wins over `mark` when a look names both: it is the more specific
 * answer, and the reason to give one is that the shipped mark was wrong.
 */
export function resolveMark(
	spec: EmbedSpec,
	data: EmbedData
):
	| { kind: 'drawn'; mark: EmbedMark; label: string }
	| { kind: 'image'; src: string; label: string }
	| null {
	const label = fillOptional(spec.chrome.label, data).text || spec.chrome.mark || 'Source';

	const image = fillOptional(spec.chrome.image, data);
	if (image.text !== '') {
		const src = imageSrc(image.text);
		if (src) return { kind: 'image', src, label };
	}

	return spec.chrome.mark ? { kind: 'drawn', mark: spec.chrome.mark, label } : null;
}

/**
 * The palette, as a `style` attribute of custom properties.
 *
 * Only the entries the look actually set, so a spec that names no background
 * inherits the dashboard's own rather than being forced onto white.
 */
export function themeStyle(theme: EmbedTheme): string {
	const parts: string[] = [];

	for (const [name, property] of [
		['accent', '--embed-accent'],
		['background', '--embed-background'],
		['foreground', '--embed-foreground'],
		['muted', '--embed-muted'],
		['border', '--embed-border']
	] as const) {
		const value = theme[name];
		if (value) parts.push(`${property}: ${value}`);
	}

	if (theme.radius) parts.push(`--embed-radius: ${RADII[theme.radius]}`);

	return parts.join('; ');
}

/** How wide each avatar size is, which is also how far a body indents past one. */
const AVATAR_WIDTHS: Record<EmbedSize, string> = {
	sm: '1.25rem',
	md: '2.25rem',
	lg: '3rem'
};

/**
 * How far the body sits in from the card's edge, or `null` for not at all.
 *
 * Slack lines everything up under the *name*, not under the avatar, and getting
 * that wrong is most of what made an embed look like a quotation of a Slack
 * message rather than one. A look asks for the effect with `frame.indent`; the
 * distance comes from the header's own avatar size, so the two cannot disagree.
 *
 * `null` unless the look asked and there is actually an avatar to clear —
 * indenting past a picture that never arrived would be a margin with no reason.
 */
export function bodyIndent(spec: EmbedSpec, blocks: readonly EmbedBlock[]): string | null {
	if (!spec.frame.indent) return null;

	const header = blocks.find((block) => block.type === 'header');
	if (!header || header.type !== 'header' || !header.avatar) return null;

	return `calc(${AVATAR_WIDTHS[header.size ?? 'md']} + 0.5rem)`;
}

/**
 * Is this look's card a dark one?
 *
 * Only the code palette needs to know (`app.css`): the familiar syntax hues are
 * chosen for a background, and every look this deployment ships is light — a
 * Slack message is white wherever the dashboard is. So the question is asked of
 * the *look*, not of the page.
 *
 * Judged from the declared background's luminance, with "no background" meaning
 * "inherits the dashboard", which is dark by default. The colour has already
 * been normalised to `#rrggbb` on the server, so this is arithmetic rather than
 * parsing.
 */
export function isDarkCard(theme: EmbedTheme): boolean {
	const background = theme.background;
	if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return true;

	const red = parseInt(background.slice(1, 3), 16);
	const green = parseInt(background.slice(3, 5), 16);
	const blue = parseInt(background.slice(5, 7), 16);
	// Rec. 601 luma, which is enough to answer "light or dark" and needs no
	// colour-space machinery to explain.
	return (red * 299 + green * 587 + blue * 114) / 1000 < 140;
}

/**
 * The classes the frame is drawn with (migration 028).
 *
 * A Slack message has no accent stripe and a lot of air; a GitHub comment is a
 * tight bordered box. Both were unreachable while every card was drawn the same
 * way, which is what the owner was looking at when they asked for these to be
 * identical to their sources.
 */
export function frameClass(frame: EmbedFrame): string {
	const parts = ['embed'];
	if (frame.border === false) parts.push('embed-borderless');
	if (frame.stripe) parts.push('embed-striped');
	parts.push(`embed-pad-${frame.padding ?? 'normal'}`);
	return parts.join(' ');
}

/** The font stack a look asked for. Names in, stacks out: the client owns these. */
export function fontClass(theme: EmbedTheme): string {
	if (theme.font === 'serif') return 'font-serif';
	if (theme.font === 'mono') return 'font-mono';
	return 'font-sans';
}

/**
 * Where a picture in an embed comes from, or `null` if nowhere safe.
 *
 * An uploaded media id becomes this deployment's own address — private, cached,
 * and served from here. An `https` URL is taken as given, because an agent
 * quoting a Slack avatar has a URL and not an upload. Everything else resolves
 * to `null`, which is what keeps `javascript:` and `data:` out of an `src`
 * even though the server has already refused them.
 */
export function imageSrc(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (MEDIA_ID.test(trimmed)) return mediaUrl(trimmed, 'thumb-640');

	return trimmed.toLowerCase().startsWith('https://') ? trimmed : null;
}

/**
 * A link out of an embed, or `null`.
 *
 * `http` and `https` only, checked here as well as on the server: this is the
 * value that reaches an `href`, and one check at the place it is used costs
 * nothing.
 */
export function link(value: string): string | null {
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();
	if (lower.startsWith('https://') || lower.startsWith('http://')) return trimmed;
	return null;
}

/** The pills a `chips` block draws: a list as sent, or one string split on commas. */
export function chipsOf(value: string): string[] {
	return value
		.split(',')
		.map((chip) => chip.trim())
		.filter((chip) => chip !== '');
}
