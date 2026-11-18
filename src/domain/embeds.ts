/**
 * Embeds, as a business rule (migration 027).
 *
 * The owner asked for agents to be able to show them a thing — a Slack message,
 * a GitHub comment, a Jira ticket, a Confluence page — looking roughly like
 * where it came from, and for the set of things to be open rather than a list
 * somebody has to keep extending. So there are two halves:
 *
 * - **A type is the look.** `register_embed_type` stores a spec: which blocks to
 *   draw, in what order, in what colours. It is upserted by slug, because
 *   registering is what an agent does at the top of every run and the second run
 *   must leave the same one row.
 * - **An embed is one thing shown.** It carries only values — the username, the
 *   channel, the text — and names the type it is drawn in.
 *
 * That split is the whole of "dynamic and adaptable": an agent registers
 * `slack-message` once and posts twenty of them, and correcting the look later
 * restyles all twenty.
 *
 * ## The spec is a declaration, and that is a security boundary
 *
 * An embed is drawn on the dashboard's own origin, from a description an agent
 * supplied. If that description were HTML or CSS, "agents may style an embed"
 * would mean "agents may run script in the owner's session".
 *
 * So {@link parseEmbedSpec} accepts a **closed vocabulary and nothing else**: the
 * block types in {@link EMBED_BLOCK_TYPES}, each with named string fields; a
 * palette whose every entry must match {@link THEME_COLOUR}; a font from
 * {@link EMBED_FONTS}; a radius from {@link EMBED_RADII}. Anything else is
 * refused here rather than escaped later — the same rule, and the same regular
 * expression, that project themes are held to (`./projects.ts`).
 *
 * `src/web/Embed.svelte` then renders those blocks with ordinary Svelte
 * bindings, so every value an agent supplied is text in a text node. There is no
 * path from a spec to markup, which is why there is nothing to sanitise.
 *
 * ## Filling a block in
 *
 * A spec's strings may carry `{{name}}`, which is replaced with `data.name` from
 * the instance. Substitution happens **in the browser** (`src/web/embeds.ts`) so
 * that one stored spec serves every embed drawn in it, and a block whose values
 * all come out empty is dropped — which is how one spec covers a Slack message
 * that has reactions on it and one that does not.
 */
import {
	findEmbedTypeById,
	findEmbedTypeBySlug,
	insertEmbed,
	isId,
	listEmbedTypes,
	listEmbedsForMessage,
	listEmbedsForRequest,
	listEmbedsForUpdate,
	upsertEmbedType,
	type Embed,
	type EmbedType
} from '$db';
import type { DomainContext } from './context';
import { conflict, invalid } from './errors';
import { THEME_COLOUR } from './projects';

/** How an agent names a look. Lowercase, so there is one spelling of each. */
export const EMBED_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const EMBED_SLUG_MAX_LENGTH = 60;
export const EMBED_NAME_MAX_LENGTH = 80;

/** Most blocks one look may draw. A card, not a document. */
export const EMBED_BLOCKS_MAX = 24;

/** Most rows a `fields` block may list. */
export const EMBED_FIELDS_MAX = 12;

/** Most values one embed may carry, and how long each may be. */
export const EMBED_DATA_KEYS_MAX = 40;
export const EMBED_VALUE_MAX_LENGTH = 20_000;

/** Most embeds one card or message may carry. */
export const EMBEDS_PER_POST_MAX = 8;

/**
 * Every block a look may draw, and nothing else.
 *
 * Chosen to cover the four the owner named without any of them needing markup:
 * a Slack message is a header and some text, a GitHub comment adds labels, a
 * Jira ticket adds a field table, a Confluence page adds a title and a body.
 */
export const EMBED_BLOCK_TYPES = [
	/** Avatar, name, where it came from, and a timestamp. */
	'header',
	/** A page title, for a look whose source leads with one. */
	'heading',
	/** Plain text, newlines kept. Never interpreted. */
	'text',
	/** Markdown, rendered by the same component a card's body uses. */
	'markdown',
	/** A fenced block in a monospace face. */
	'code',
	/** An indented quotation with a rule down its left edge. */
	'quote',
	/** Label/value rows: what a ticket's sidebar is. */
	'fields',
	/** Little pills: labels, tags, reactions. */
	'chips',
	/** A picture: an uploaded media id, or an https URL. */
	'image',
	/** A horizontal rule. */
	'divider',
	/** A last line, optionally a link out to the source. */
	'footer'
] as const;

export type EmbedBlockType = (typeof EMBED_BLOCK_TYPES)[number];

/** The three faces a look may ask for. Names, not font stacks: the client owns those. */
export const EMBED_FONTS = ['sans', 'serif', 'mono'] as const;
export type EmbedFont = (typeof EMBED_FONTS)[number];

export const EMBED_RADII = ['none', 'sm', 'md', 'lg'] as const;
export type EmbedRadius = (typeof EMBED_RADII)[number];

/**
 * The layout knobs, all closed lists (migration 028).
 *
 * The owner asked for the built-in looks to be *identical* to their sources, and
 * a palette alone cannot do that: a Slack message is a rounded-square avatar
 * with the name and time on one line, and a GitHub comment is a circular avatar
 * in a tinted bar above a white body. Those are layout facts, not colours.
 *
 * They are enums for the same reason the colours are hex literals: an agent
 * supplies them, and the renderer turns each into a class it wrote itself. There
 * is no string here that reaches CSS.
 */
export const EMBED_AVATAR_SHAPES = ['circle', 'rounded', 'square'] as const;
export type EmbedAvatarShape = (typeof EMBED_AVATAR_SHAPES)[number];

export const EMBED_SIZES = ['sm', 'md', 'lg'] as const;
export type EmbedSize = (typeof EMBED_SIZES)[number];

export const EMBED_HEADER_LAYOUTS = ['inline', 'stacked'] as const;
export type EmbedHeaderLayout = (typeof EMBED_HEADER_LAYOUTS)[number];

/** How a value is coloured against the rest of the card. */
export const EMBED_TONES = ['normal', 'muted', 'accent'] as const;
export type EmbedTone = (typeof EMBED_TONES)[number];

/** Pills like Slack reactions, lozenges like a Jira status, tags like a label. */
export const EMBED_CHIP_STYLES = ['pill', 'lozenge', 'tag'] as const;
export type EmbedChipStyle = (typeof EMBED_CHIP_STYLES)[number];

export const EMBED_FIELD_LAYOUTS = ['rows', 'inline'] as const;
export type EmbedFieldLayout = (typeof EMBED_FIELD_LAYOUTS)[number];

export const EMBED_PADDINGS = ['tight', 'normal', 'roomy'] as const;
export type EmbedPadding = (typeof EMBED_PADDINGS)[number];

/**
 * The brand marks this deployment can draw (migration 029).
 *
 * The owner: "I would expect embeds to at least have the slack/github icon etc."
 * They are right, and it is a point about *this* surface rather than about the
 * sources: a real Slack message needs no Slack logo because you are already in
 * Slack, but a dashboard is a wall of quotations from four different places, and
 * the first thing you need from one is where it came from.
 *
 * A closed list, drawn as inline SVG the client owns (`EmbedMark.svelte`). That
 * is deliberate on three counts: nothing is fetched, so a mark cannot leak the
 * owner's address to a third party or vanish when a CDN does; nothing an agent
 * sends becomes markup; and a name is all a look has to carry. A source we do
 * not ship a mark for uses `chrome.image` instead.
 */
export const EMBED_MARKS = [
	'slack',
	'github',
	'gitlab',
	'jira',
	'confluence',
	'linear',
	'notion',
	'figma',
	'link'
] as const;

export type EmbedMark = (typeof EMBED_MARKS)[number];

/**
 * The card itself, rather than what is in it.
 *
 * A Slack message has no accent stripe and a lot of air; a GitHub comment is a
 * tight bordered box. Both were unreachable while every embed was drawn with the
 * same frame, which is why this exists.
 */
export type EmbedFrame = {
	/** Draw the outer border. `true` unless a look says otherwise. */
	border?: boolean;
	/** The accent bar down the left edge. Off unless a look asks. */
	stripe?: boolean;
	padding?: EmbedPadding;
	/**
	 * Line the body up under the header's words rather than under its avatar.
	 *
	 * This is Slack's shape, and it is the difference between a card that looks
	 * like a Slack message and one that looks like a Slack message with the text
	 * fallen out of alignment. The renderer takes the distance from the header's
	 * own avatar size, so a look asks for the effect rather than for a number.
	 */
	indent?: boolean;
};

/** The palette a look is drawn in. Every colour is a hex literal or it is refused. */
export type EmbedTheme = {
	accent?: string;
	background?: string;
	foreground?: string;
	muted?: string;
	border?: string;
	font?: EmbedFont;
	radius?: EmbedRadius;
};

/** The badge along the top: where this came from. */
export type EmbedChrome = {
	/** "Slack", "GitHub" — or a `{{placeholder}}`, for a look that varies. */
	label?: string;
	/** One or two emoji beside the label. */
	icon?: string;
	/**
	 * The source's own brand mark, from {@link EMBED_MARKS} (migration 029).
	 *
	 * Drawn small in the card's top corner, which is where a quotation from
	 * somewhere else is marked without arguing with the thing being quoted.
	 */
	mark?: EmbedMark;
	/**
	 * A mark for a source we ship none for: a media id, or an https image URL.
	 *
	 * The escape hatch that keeps the closed list from being a limit — an agent
	 * registering a look for its own tooling uploads the logo and names it here.
	 */
	image?: string;
};

export type EmbedBlock =
	| {
			type: 'header';
			avatar?: string;
			title?: string;
			subtitle?: string;
			meta?: string;
			/** Slack's avatar is a rounded square; GitHub's is a circle. */
			shape?: EmbedAvatarShape;
			size?: EmbedSize;
			/** `inline` puts the name and the time on one line, as Slack does. */
			layout?: EmbedHeaderLayout;
			/** Draw it as a tinted bar above the body, as a GitHub comment is. */
			bar?: boolean;
	  }
	| { type: 'heading'; value: string; level?: 1 | 2 }
	| { type: 'text'; value: string; tone?: EmbedTone; size?: EmbedSize }
	| { type: 'markdown'; value: string; size?: EmbedSize }
	| { type: 'code'; value: string; language?: string }
	| { type: 'quote'; value: string }
	| {
			type: 'fields';
			items: { label: string; value: string }[];
			layout?: EmbedFieldLayout;
	  }
	| { type: 'chips'; value: string; style?: EmbedChipStyle }
	| { type: 'image'; value: string; alt?: string }
	| { type: 'divider' }
	| { type: 'footer'; value?: string; url?: string };

export type EmbedSpec = {
	theme: EmbedTheme;
	chrome: EmbedChrome;
	frame: EmbedFrame;
	blocks: EmbedBlock[];
};

/** The values one embed shows. A string, or a list of them for chips. */
export type EmbedData = Record<string, string | string[]>;

/**
 * One look, as an agent and the browser both read it.
 *
 * `spec` is the parsed object rather than the stored text: every reader wants
 * the object, and parsing it in one place means a row that somehow holds
 * rubbish is a caught error here rather than a blank card there.
 */
export type EmbedTypeView = {
	slug: string;
	name: string;
	/** Whether this deployment ships it, in which case no agent may redefine it. */
	builtIn: boolean;
	spec: EmbedSpec;
	updatedAt: number;
};

/** One embed as a card renders it: the values, and the look to draw them in. */
export type EmbedView = {
	id: string;
	/** Which card it is on: exactly one of the four (migration 030). */
	updateId: string | null;
	messageId: string | null;
	requestId: string | null;
	taskId: string | null;
	/** Which look, so a client can group or debug without another lookup. */
	type: string;
	typeName: string;
	/**
	 * The look itself, carried on every embed rather than sent once as a table.
	 *
	 * Denormalised on purpose: a card is rendered from the update it was handed,
	 * and a stream frame carrying one update has to be enough on its own. A spec
	 * is under a kilobyte, and the alternative is every renderer holding a
	 * registry it has to keep in step.
	 */
	spec: EmbedSpec;
	data: EmbedData;
	sourceUrl: string | null;
	createdAt: number;
};

/** A colour, checked and normalised to `#rrggbb`, exactly as a project theme is. */
function colour(value: unknown, field: string): string {
	if (typeof value !== 'string' || !THEME_COLOUR.test(value.trim())) {
		throw invalid(`${field} must be a hex colour like #1a2b3c`);
	}
	const hex = value.trim().slice(1).toLowerCase();
	return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex}`;
}

/** A string field of a block: present or absent, never markup, never enormous. */
function text(value: unknown, field: string, required = false): string | undefined {
	if (value === undefined || value === null) {
		if (required) throw invalid(`${field} is required`);
		return undefined;
	}
	if (typeof value !== 'string') throw invalid(`${field} must be text`);
	if (value.length > EMBED_VALUE_MAX_LENGTH) {
		throw invalid(`${field} must be at most ${EMBED_VALUE_MAX_LENGTH} characters`);
	}
	return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	field: string
): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
		throw invalid(`${field} must be one of: ${allowed.join(', ')}`);
	}
	return value as T;
}

function parseTheme(raw: unknown): EmbedTheme {
	if (raw === undefined || raw === null) return {};
	const source = object(raw, 'theme');
	const theme: EmbedTheme = {};

	for (const key of ['accent', 'background', 'foreground', 'muted', 'border'] as const) {
		if (source[key] !== undefined && source[key] !== null) {
			theme[key] = colour(source[key], `theme.${key}`);
		}
	}

	const font = oneOf(source.font, EMBED_FONTS, 'theme.font');
	if (font) theme.font = font;
	const radius = oneOf(source.radius, EMBED_RADII, 'theme.radius');
	if (radius) theme.radius = radius;

	return theme;
}

/**
 * The card itself: border, stripe, air.
 *
 * `border` defaults to `true` because a card with no edge is the unusual case,
 * and `stripe` to `false` because most sources do not have one — a Slack message
 * certainly does not, which is what this exists to fix (migration 028).
 */
function parseFrame(raw: unknown): EmbedFrame {
	if (raw === undefined || raw === null) return {};
	const source = object(raw, 'frame');
	const frame: EmbedFrame = {};

	if (typeof source.border === 'boolean') frame.border = source.border;
	if (typeof source.stripe === 'boolean') frame.stripe = source.stripe;
	if (source.indent === true) frame.indent = true;
	const padding = oneOf(source.padding, EMBED_PADDINGS, 'frame.padding');
	if (padding) frame.padding = padding;

	return frame;
}

function parseChrome(raw: unknown): EmbedChrome {
	if (raw === undefined || raw === null) return {};
	const source = object(raw, 'chrome');
	const chrome: EmbedChrome = {};

	const label = text(source.label, 'chrome.label');
	if (label !== undefined) chrome.label = label;
	const icon = text(source.icon, 'chrome.icon');
	if (icon !== undefined) chrome.icon = icon;
	const mark = oneOf(source.mark, EMBED_MARKS, 'chrome.mark');
	if (mark) chrome.mark = mark;
	const image = text(source.image, 'chrome.image');
	if (image !== undefined) chrome.image = image;

	return chrome;
}

function parseBlock(raw: unknown, at: number): EmbedBlock {
	const source = object(raw, `blocks[${at}]`);
	const type = oneOf(source.type, EMBED_BLOCK_TYPES, `blocks[${at}].type`);
	if (!type) throw invalid(`blocks[${at}].type is required`);

	const field = (name: string, required = false) =>
		text(source[name], `blocks[${at}].${name}`, required);

	switch (type) {
		case 'header': {
			const block: Extract<EmbedBlock, { type: 'header' }> = { type };
			for (const name of ['avatar', 'title', 'subtitle', 'meta'] as const) {
				const value = field(name);
				if (value !== undefined) block[name] = value;
			}
			const shape = oneOf(source.shape, EMBED_AVATAR_SHAPES, `blocks[${at}].shape`);
			if (shape) block.shape = shape;
			const size = oneOf(source.size, EMBED_SIZES, `blocks[${at}].size`);
			if (size) block.size = size;
			const layout = oneOf(source.layout, EMBED_HEADER_LAYOUTS, `blocks[${at}].layout`);
			if (layout) block.layout = layout;
			if (source.bar === true) block.bar = true;
			return block;
		}
		case 'heading': {
			// Two levels and no more: a card is not a document, and a spec that
			// could ask for an `<h6>` would be a spec asking for a type scale.
			const level = source.level === 2 ? 2 : 1;
			return { type, value: field('value', true)!, level };
		}
		case 'text': {
			const tone = oneOf(source.tone, EMBED_TONES, `blocks[${at}].tone`);
			const size = oneOf(source.size, EMBED_SIZES, `blocks[${at}].size`);
			return {
				type,
				value: field('value', true)!,
				...(tone ? { tone } : {}),
				...(size ? { size } : {})
			};
		}
		case 'markdown': {
			const size = oneOf(source.size, EMBED_SIZES, `blocks[${at}].size`);
			return { type, value: field('value', true)!, ...(size ? { size } : {}) };
		}
		case 'chips': {
			const style = oneOf(source.style, EMBED_CHIP_STYLES, `blocks[${at}].style`);
			return { type, value: field('value', true)!, ...(style ? { style } : {}) };
		}
		case 'quote':
			return { type, value: field('value', true)! };
		case 'code': {
			const language = field('language');
			return { type, value: field('value', true)!, ...(language ? { language } : {}) };
		}
		case 'image': {
			const alt = field('alt');
			return { type, value: field('value', true)!, ...(alt ? { alt } : {}) };
		}
		case 'divider':
			return { type };
		case 'footer': {
			const value = field('value');
			const url = field('url');
			return { type, ...(value ? { value } : {}), ...(url ? { url } : {}) };
		}
		case 'fields': {
			if (!Array.isArray(source.items)) throw invalid(`blocks[${at}].items must be a list`);
			if (source.items.length > EMBED_FIELDS_MAX) {
				throw invalid(`blocks[${at}].items may hold at most ${EMBED_FIELDS_MAX} rows`);
			}
			const items = source.items.map((entry, index) => {
				const row = object(entry, `blocks[${at}].items[${index}]`);
				return {
					label: text(row.label, `blocks[${at}].items[${index}].label`, true)!,
					value: text(row.value, `blocks[${at}].items[${index}].value`, true)!
				};
			});
			const layout = oneOf(source.layout, EMBED_FIELD_LAYOUTS, `blocks[${at}].layout`);
			return { type, items, ...(layout ? { layout } : {}) };
		}
	}
}

/**
 * Check a spec, and hand back the normalised version that gets stored.
 *
 * Everything outside the vocabulary is dropped rather than kept: an unknown key
 * that survived would be a key some future renderer might read, and the point of
 * a closed vocabulary is that there is nothing in a stored spec that nobody
 * planned for.
 *
 * @throws {@link DomainError} `invalid_argument`, naming the field.
 */
export function parseEmbedSpec(raw: unknown): EmbedSpec {
	const source = object(raw, 'spec');

	if (!Array.isArray(source.blocks)) throw invalid('spec.blocks must be a list of blocks');
	if (source.blocks.length === 0) throw invalid('spec.blocks must hold at least one block');
	if (source.blocks.length > EMBED_BLOCKS_MAX) {
		throw invalid(`spec.blocks may hold at most ${EMBED_BLOCKS_MAX} blocks`);
	}

	return {
		theme: parseTheme(source.theme),
		chrome: parseChrome(source.chrome),
		frame: parseFrame(source.frame),
		blocks: source.blocks.map(parseBlock)
	};
}

/** The stored spec, parsed. A row that cannot be read draws nothing rather than throwing. */
function specOf(row: EmbedType): EmbedSpec | undefined {
	try {
		return parseEmbedSpec(JSON.parse(row.spec));
	} catch {
		// Unreachable through this module, which validates before it writes;
		// reachable through a hand-edited row, and a blank card is a better answer
		// there than a 500 on the whole timeline.
		return undefined;
	}
}

function typeView(row: EmbedType, spec: EmbedSpec): EmbedTypeView {
	return {
		slug: row.slug,
		name: row.name,
		builtIn: row.agentId === null,
		spec,
		updatedAt: row.updatedAt
	};
}

export type RegisterEmbedTypeInput = {
	/** The registering agent, resolved from its bearer token. */
	agentId: string;
	slug: string;
	name: string;
	/** The spec, as the agent sent it. Checked here before anything is written. */
	spec: unknown;
};

/**
 * Register a look, or correct the one this agent already registered.
 *
 * @throws {@link DomainError} `invalid_argument` for a slug, name or spec that
 *   does not hold up; `conflict` when the slug already names a look this agent
 *   does not own — including the ones the deployment ships, which nobody owns.
 */
export function registerEmbedType(
	ctx: DomainContext,
	input: RegisterEmbedTypeInput
): EmbedTypeView {
	const slug = input.slug.trim().toLowerCase();
	if (slug.length === 0 || slug.length > EMBED_SLUG_MAX_LENGTH || !EMBED_SLUG.test(slug)) {
		throw invalid(
			`slug must be lowercase words joined by hyphens, e.g. "slack-message", ` +
				`at most ${EMBED_SLUG_MAX_LENGTH} characters`
		);
	}

	const name = input.name.trim();
	if (name.length === 0 || name.length > EMBED_NAME_MAX_LENGTH) {
		throw invalid(`name is required, and at most ${EMBED_NAME_MAX_LENGTH} characters`);
	}

	const spec = parseEmbedSpec(input.spec);

	const existing = findEmbedTypeBySlug(ctx.db, slug);
	if (existing && existing.agentId !== input.agentId) {
		throw conflict(
			existing.agentId === null
				? `"${slug}" is one of the looks this dashboard ships, so it cannot be redefined. ` +
						`Register your own under a different slug.`
				: `"${slug}" was registered by another agent. Pick a different slug.`
		);
	}

	const row = upsertEmbedType(ctx.db, {
		slug,
		name,
		agentId: input.agentId,
		spec: JSON.stringify(spec),
		at: ctx.now()
	});

	return typeView(row, spec);
}

/** Every look an agent may draw in, built-ins first. */
export function listEmbedTypeViews(ctx: DomainContext): EmbedTypeView[] {
	const views: EmbedTypeView[] = [];
	for (const row of listEmbedTypes(ctx.db)) {
		const spec = specOf(row);
		if (spec) views.push(typeView(row, spec));
	}
	return views;
}

/** One embed as an agent asks for it, alongside a post. */
export type NewEmbedInput = {
	/** The look's slug. */
	type: string;
	/** The values it shows. */
	data: unknown;
	/** Where it was copied from, if the agent says. */
	sourceUrl?: string | null;
};

/**
 * Check that every embed on a post can actually be drawn, before anything is
 * written.
 *
 * Checked up front for the same reason `media_ids` is (`./media.ts`): a post
 * that published with one of its embeds silently missing is worse than one that
 * failed to post and said why.
 *
 * @throws {@link DomainError} `invalid_argument` for an unknown look, a
 *   `data` that is not a flat object of strings, or too many of either.
 */
export function checkedEmbeds(
	ctx: DomainContext,
	embeds: readonly NewEmbedInput[]
): { typeId: string; data: string; sourceUrl: string | null }[] {
	if (embeds.length > EMBEDS_PER_POST_MAX) {
		throw invalid(`a post may carry at most ${EMBEDS_PER_POST_MAX} embeds`);
	}

	return embeds.map((embed, at) => {
		const slug = String(embed.type ?? '')
			.trim()
			.toLowerCase();
		const type = findEmbedTypeBySlug(ctx.db, slug);
		if (!type) {
			throw invalid(
				`embeds[${at}]: no embed type "${slug}". Call list_embed_types to see what is ` +
					`registered, or register_embed_type to add it.`
			);
		}

		return {
			typeId: type.id,
			data: JSON.stringify(parseEmbedData(embed.data, `embeds[${at}].data`)),
			sourceUrl: parseSourceUrl(embed.sourceUrl, `embeds[${at}].source_url`)
		};
	});
}

/**
 * The values one embed shows: a flat object of strings, or lists of them.
 *
 * Flat on purpose. A block names a value by one word — `{{username}}` — so
 * nesting would be structure nothing can address, and allowing it would be
 * inviting agents to send objects that silently never render.
 */
export function parseEmbedData(raw: unknown, field: string): EmbedData {
	const source = object(raw ?? {}, field);
	const keys = Object.keys(source);
	if (keys.length > EMBED_DATA_KEYS_MAX) {
		throw invalid(`${field} may hold at most ${EMBED_DATA_KEYS_MAX} values`);
	}

	const data: EmbedData = {};
	for (const key of keys) {
		const value = source[key];
		if (value === undefined || value === null) continue;

		if (Array.isArray(value)) {
			data[key] = value.map((entry, index) => scalar(entry, `${field}.${key}[${index}]`));
			continue;
		}
		data[key] = scalar(value, `${field}.${key}`);
	}

	return data;
}

/**
 * One value, as text.
 *
 * Numbers and booleans are accepted and stringified rather than refused: a
 * language model writing JSON will send `42` for an issue number sooner or
 * later, and refusing it would be a rule about JSON rather than about embeds.
 */
function scalar(value: unknown, field: string): string {
	if (typeof value === 'string') {
		if (value.length > EMBED_VALUE_MAX_LENGTH) {
			throw invalid(`${field} must be at most ${EMBED_VALUE_MAX_LENGTH} characters`);
		}
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'boolean') return String(value);
	throw invalid(`${field} must be text, a number, or a list of them`);
}

/**
 * The link out to the source, if there is one.
 *
 * `https` and `http` only. A `javascript:` URL in an `href` is script execution
 * in the owner's session, and the browser is not the place to be deciding that:
 * it is decided here, once, before the row exists.
 */
function parseSourceUrl(raw: unknown, field: string): string | null {
	if (raw === undefined || raw === null || raw === '') return null;
	if (typeof raw !== 'string') throw invalid(`${field} must be a URL`);

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw invalid(`${field} must be an absolute http or https URL`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw invalid(`${field} must be an absolute http or https URL`);
	}
	return url.toString();
}

export type AttachEmbedsInput = {
	embeds: readonly { typeId: string; data: string; sourceUrl: string | null }[];
	/** Exactly one of the four cards this belongs to (migration 030). */
	updateId?: string | null;
	messageId?: string | null;
	requestId?: string | null;
	taskId?: string | null;
	agentId?: string | null;
	author: string;
};

/** Write the embeds a post carried. Already checked by {@link checkedEmbeds}. */
export function attachEmbeds(ctx: DomainContext, input: AttachEmbedsInput): Embed[] {
	return input.embeds.map((embed) =>
		insertEmbed(ctx.db, {
			typeId: embed.typeId,
			updateId: input.updateId ?? null,
			messageId: input.messageId ?? null,
			requestId: input.requestId ?? null,
			taskId: input.taskId ?? null,
			agentId: input.agentId ?? null,
			author: input.author,
			data: embed.data,
			sourceUrl: embed.sourceUrl,
			at: ctx.now()
		})
	);
}

/** One row as a card renders it, or `undefined` when its look cannot be read. */
function embedView(ctx: DomainContext, row: Embed): EmbedView | undefined {
	const type = findEmbedTypeById(ctx.db, row.typeId);
	if (!type) return undefined;
	const spec = specOf(type);
	if (!spec) return undefined;

	let data: EmbedData;
	try {
		data = parseEmbedData(JSON.parse(row.data), 'data');
	} catch {
		data = {};
	}

	return {
		id: row.id,
		updateId: row.updateId,
		messageId: row.messageId,
		requestId: row.requestId,
		taskId: row.taskId,
		type: type.slug,
		typeName: type.name,
		spec,
		data,
		sourceUrl: row.sourceUrl,
		createdAt: row.createdAt
	};
}

/** Every embed on one message, for the thread that renders it. */
export function listMessageEmbeds(ctx: DomainContext, messageId: string): EmbedView[] {
	return views(ctx, listEmbedsForMessage(ctx.db, messageId));
}

/** Every embed on one approval, for the box that renders it (migration 030). */
export function listRequestEmbeds(ctx: DomainContext, requestId: string): EmbedView[] {
	return views(ctx, listEmbedsForRequest(ctx.db, requestId));
}

/** Rows to views, dropping any whose look cannot be read. */
function views(ctx: DomainContext, rows: readonly Embed[]): EmbedView[] {
	return rows
		.map((row) => embedView(ctx, row))
		.filter((view): view is EmbedView => view !== undefined);
}

/**
 * The embeds on a page of updates, grouped by update.
 *
 * The same shape, and for the same reasons, as `listUpdateMedia` in
 * `./media.ts`: a second read against the page that came back, with updates that
 * carry nothing absent rather than present-and-empty.
 */
export function listUpdateEmbeds(
	ctx: DomainContext,
	updateIds: readonly string[]
): Record<string, EmbedView[]> {
	const byUpdate: Record<string, EmbedView[]> = {};

	for (const updateId of updateIds) {
		const rows = listEmbedsForUpdate(ctx.db, updateId);
		if (rows.length === 0) continue;

		const views = rows
			.map((row) => embedView(ctx, row))
			.filter((view): view is EmbedView => view !== undefined);
		if (views.length > 0) byUpdate[updateId] = views;
	}

	return byUpdate;
}

/** Whether a string is a media id, for a client deciding how to load an avatar. */
export function isMediaReference(value: string): boolean {
	return isId(value);
}
