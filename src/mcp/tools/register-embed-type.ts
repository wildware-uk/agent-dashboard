/**
 * `register_embed_type` (migration 027) — teaching the dashboard a new look.
 *
 * The owner asked for embeds that "look roughly like the source they came from"
 * and, in the same breath, for the set of them to be "dynamic and adaptable to
 * embed anything". Those two together are what this tool is: an agent declares a
 * look once, and then posts things in it.
 *
 * The description below carries the whole vocabulary, because an agent reads
 * this once and has to get a spec right without a round trip to ask what a block
 * is. It also says plainly what the spec is *not* — HTML, CSS, a template — so
 * an agent does not waste a call discovering that.
 */
import {
	EMBED_AVATAR_SHAPES,
	EMBED_MARKS,
	EMBED_BLOCKS_MAX,
	EMBED_BLOCK_TYPES,
	EMBED_CHIP_STYLES,
	EMBED_FONTS,
	EMBED_NAME_MAX_LENGTH,
	EMBED_PADDINGS,
	EMBED_RADII,
	EMBED_SIZES,
	EMBED_SLUG_MAX_LENGTH,
	registerEmbedType
} from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	slug: z
		.string()
		.max(EMBED_SLUG_MAX_LENGTH)
		.describe(
			`How you will name this look when you post one, e.g. "slack-message". Lowercase ` +
				`words joined by hyphens. Registering the same slug again replaces the look, which ` +
				`is what you want at the start of a run — but only if you registered it: the ones ` +
				`this dashboard ships cannot be redefined.`
		),
	name: z
		.string()
		.max(EMBED_NAME_MAX_LENGTH)
		.describe(`What to call it for a human, e.g. "Slack message".`),
	spec: z
		.record(z.string(), z.unknown())
		.describe(
			`The look itself: { theme, chrome, blocks }. See the description for the whole ` +
				`vocabulary. It is a declaration, never HTML or CSS.`
		)
};

export const registerEmbedTypeTool: McpTool<typeof inputSchema> = {
	name: 'register_embed_type',
	config: {
		title: 'Register an embed look',
		description: [
			'Teach the dashboard how to draw a kind of thing, so you can show your owner a Slack',
			'message, a GitHub comment, a Jira ticket or anything else looking roughly like where it',
			'came from instead of pasting it as flat text.',
			'',
			'Two steps: register the look once, then pass `embeds` to post_update or post_message as',
			'often as you like. Correcting the look later restyles every embed already posted in it.',
			'',
			'Call list_embed_types first — slack-message, github-comment, jira-issue,',
			'confluence-page and linked-page already exist, and reusing one is better than',
			'registering a near-copy.',
			'',
			'## The spec',
			'',
			'It is a DECLARATION, not markup. HTML, CSS and template languages are all refused:',
			"an embed is drawn on your owner's dashboard, so the only thing that can be safely",
			'accepted from you is a description of which blocks to draw in which colours. Every',
			'value you send is rendered as text.',
			'',
			'```json',
			'{',
			'  "theme": {',
			'    "accent": "#611f69", "background": "#ffffff", "foreground": "#1d1c1d",',
			'    "muted": "#616061", "border": "#e2e2e2",',
			'    "font": "sans", "radius": "sm"',
			'  },',
			'  "frame": { "border": true, "stripe": false, "padding": "roomy", "indent": true },',
			'  "blocks": [',
			'    { "type": "header", "avatar": "{{avatar}}", "title": "{{username}}",',
			'      "meta": "{{time}}", "shape": "rounded", "size": "md", "layout": "inline" },',
			'    { "type": "markdown", "value": "{{text}}", "size": "md" },',
			'    { "type": "chips", "value": "{{reactions}}", "style": "pill" },',
			'    { "type": "footer", "value": "{{channel}}", "url": "{{permalink}}" }',
			'  ]',
			'}',
			'```',
			'',
			'That is the built-in slack-message look, and it is worth reading as an example of the',
			'point: it carries no badge, because a Slack message does not have one. Copying a source',
			'means copying its shape, not labelling the card with its name.',
			'',
			`Colours must be hex literals (#rgb or #rrggbb). font is one of ${EMBED_FONTS.join(', ')};`,
			`radius is one of ${EMBED_RADII.join(', ')}. Everything in theme is optional, and an`,
			'omitted colour is inherited from the dashboard rather than forced to white.',
			'',
			'## frame — the card, rather than what is in it',
			'',
			'- border  (default true)  — draw the outer edge.',
			'- stripe  (default false) — an accent bar down the left. Most sources have none.',
			`- padding (default normal) — one of ${EMBED_PADDINGS.join(', ')}.`,
			"- indent  (default false) — line the body up under the header's WORDS rather than under",
			"  its avatar. This is Slack's shape, and leaving it off is the single thing that makes a",
			'  Slack card read as a quotation rather than as the message.',
			'',
			'## chrome — saying where the card came from',
			'',
			`- mark  — one of ${EMBED_MARKS.join(', ')}. Drawn small in the card's top corner. Use`,
			'  this: a dashboard is a wall of quotations from several places at once, and the mark is',
			'  how a reader tells them apart at a glance. It costs the look nothing, because it is',
			'  drawn over the card rather than in it.',
			'- image — a media_id or an https image URL, for a source we draw no mark for. Upload your',
			"  tool's logo with create_upload and name it here. It wins over mark when you give both.",
			'- label — a badge bar across the top, with an optional emoji `icon` beside it. Usually',
			'  wrong if you are copying a real source, because a Slack message has no "Slack" bar on',
			'  it — prefer `mark`. Worth it for a look with no brand of its own, where naming the site',
			'  is the only thing that says where the card is from.',
			'',
			'The mark and the label both link to the source_url you pass when you post.',
			'',
			`## Blocks (at most ${EMBED_BLOCKS_MAX}, drawn in order)`,
			'',
			'- header  — { avatar?, title?, subtitle?, meta?, shape?, size?, layout?, bar? }.',
			'  avatar is a media_id from create_upload, or an https image URL.',
			`  shape is one of ${EMBED_AVATAR_SHAPES.join(', ')} — Slack's is rounded, GitHub's is`,
			`  circle. size is one of ${EMBED_SIZES.join(', ')}. layout "inline" puts the title and`,
			'  everything beside it on one line, which is Slack\'s; "stacked" (the default) puts the',
			'  subtitle under the title with the meta on the right. bar:true draws the header as a',
			'  tinted band above the body, which is a GitHub comment exactly.',
			'- heading — { value, level? }. A page title. level is 1 or 2.',
			'- text    — { value, tone?, size? }. Plain text, newlines kept, never interpreted.',
			'  tone is normal, muted or accent; size is sm, md or lg.',
			'- markdown— { value, size? }. Rendered as markdown, same as an update body.',
			'- code    — { value, language? }. A fenced block in a monospace face.',
			'- quote   — { value }. Indented, with a rule down the left.',
			'- fields  — { items: [{ label, value }], layout? }. What a ticket sidebar is.',
			'  layout is "rows" (a label/value table) or "inline".',
			`  - chips   — { value, style? }. style is one of ${EMBED_CHIP_STYLES.join(', ')}: a pill is`,
			'  a Slack reaction, a lozenge is a Jira status, a tag is a label. Send a list, or one',
			'  comma-separated string.',
			'- image   — { value, alt? }. A media_id or an https image URL.',
			'- divider — {}',
			'- footer  — { value?, url? }. A last line, optionally linking out.',
			`  Every block type: ${EMBED_BLOCK_TYPES.join(', ')}.`,
			'',
			'## Filling one in',
			'',
			'Any string in the spec may carry {{name}}, which is replaced with the value you send',
			'under that name when you post. A block whose values all come out empty is not drawn,',
			'so one look covers a message that has reactions on it and one that does not.',
			'',
			'{{source_url}} is filled from the source_url you pass when you post, so a footer can',
			'link back without you sending the URL twice. The badge along the top links there too.',
			'',
			'Arguments:',
			`- slug (required): lowercase-hyphenated, at most ${EMBED_SLUG_MAX_LENGTH} characters.`,
			`- name (required): what a human calls it, at most ${EMBED_NAME_MAX_LENGTH} characters.`,
			'- spec (required): the object above.',
			'',
			'Returns { slug, name, built_in, blocks }. On failure: "invalid_argument" names the',
			'field that did not hold up — an unknown block type, a colour that is not a hex literal,',
			'a spec with no blocks. "conflict" means that slug is already somebody else\'s look, or',
			'is one this dashboard ships; pick another slug.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const type = registerEmbedType(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				slug: args.slug,
				name: args.name,
				spec: args.spec
			});

			return ok(
				`Registered the "${type.slug}" look. Pass embeds: [{ type: "${type.slug}", data: ` +
					`{ ... } }] to post_update or post_message to show one.`,
				{
					slug: type.slug,
					name: type.name,
					built_in: type.builtIn,
					blocks: type.spec.blocks.map((block) => block.type)
				}
			);
		})
};
