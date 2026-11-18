import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { createProject } from './projects';
import { postMessage } from './messages';
import { postUpdate } from './updates';
import { createRequest } from './requests';
import { isDomainError } from './errors';
import {
	listEmbedTypeViews,
	listMessageEmbeds,
	listRequestEmbeds,
	listUpdateEmbeds,
	parseEmbedSpec,
	registerEmbedType
} from './embeds';

/**
 * Embeds (migration 027).
 *
 * Two things are being pinned here, and the first matters more than it looks.
 *
 * **The spec is a closed vocabulary.** The owner asked for embeds "styled to
 * look roughly like the source they came from", registered dynamically by
 * agents. Styling supplied by an agent and drawn on the owner's own origin is
 * exactly the shape of a cross-site scripting bug, and the only reason it is not
 * one here is that nothing outside the vocabulary survives this module. So the
 * refusals below are the feature, not its edges.
 *
 * **A type is not an instance.** Registering the same slug twice replaces the
 * look and restyles everything already posted in it, which is what makes the
 * feature dynamic in the way that was asked for.
 */

let h: Harness;
let agentId: string;
let slug: string;

function refusalCode(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	return 'no error thrown';
}

const A_SPEC = {
	theme: { accent: '#611F69', background: '#ffffff', font: 'sans', radius: 'md' },
	chrome: { label: 'Slack', icon: '💬' },
	blocks: [
		{ type: 'header', avatar: '{{avatar}}', title: '{{username}}', subtitle: '{{channel}}' },
		{ type: 'markdown', value: '{{text}}' }
	]
};

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
});

describe('what a spec may say', () => {
	it('keeps the vocabulary and normalises the palette', () => {
		const spec = parseEmbedSpec(A_SPEC);

		// Lowercased and expanded, exactly as a project theme's colours are, so two
		// spellings of one colour are one string.
		expect(spec.theme).toEqual({
			accent: '#611f69',
			background: '#ffffff',
			font: 'sans',
			radius: 'md'
		});
		expect(spec.blocks.map((block) => block.type)).toEqual(['header', 'markdown']);
	});

	it('expands a three-digit colour, so #fff and #ffffff are one value', () => {
		const spec = parseEmbedSpec({ theme: { accent: '#F0A' }, blocks: [{ type: 'divider' }] });

		expect(spec.theme.accent).toBe('#ff00aa');
	});

	it('refuses a colour that is not a hex literal', () => {
		// This is the security boundary: these values are written into a CSS custom
		// property on the owner's dashboard. `red` would work, and so would a
		// closing brace.
		for (const accent of ['red', 'var(--x)', 'url(https://x)', '#fff; }', 'rgb(1,2,3)']) {
			expect(
				refusalCode(() => parseEmbedSpec({ theme: { accent }, blocks: [{ type: 'divider' }] })),
				accent
			).toBe('invalid_argument');
		}
	});

	it('refuses a block type nobody wrote a renderer for', () => {
		expect(refusalCode(() => parseEmbedSpec({ blocks: [{ type: 'iframe', value: 'x' }] }))).toBe(
			'invalid_argument'
		);
		expect(
			refusalCode(() => parseEmbedSpec({ blocks: [{ type: 'html', value: '<b>x</b>' }] }))
		).toBe('invalid_argument');
	});

	it('drops anything outside the vocabulary rather than storing it', () => {
		const spec = parseEmbedSpec({
			theme: { accent: '#000000', onclick: 'alert(1)' },
			chrome: { label: 'Slack', script: 'x' },
			blocks: [{ type: 'text', value: 'hello', style: 'color:red' }]
		});

		expect(spec.theme).toEqual({ accent: '#000000' });
		expect(spec.chrome).toEqual({ label: 'Slack' });
		expect(spec.blocks).toEqual([{ type: 'text', value: 'hello' }]);
	});

	it('refuses a spec with no blocks, or one that is not an object at all', () => {
		expect(refusalCode(() => parseEmbedSpec({ blocks: [] }))).toBe('invalid_argument');
		expect(refusalCode(() => parseEmbedSpec({}))).toBe('invalid_argument');
		expect(refusalCode(() => parseEmbedSpec('<div>'))).toBe('invalid_argument');
	});

	it('refuses a font or a radius it has no class for', () => {
		expect(
			refusalCode(() =>
				parseEmbedSpec({ theme: { font: 'Comic Sans' }, blocks: [{ type: 'divider' }] })
			)
		).toBe('invalid_argument');
		expect(
			refusalCode(() =>
				parseEmbedSpec({ theme: { radius: '9999px' }, blocks: [{ type: 'divider' }] })
			)
		).toBe('invalid_argument');
	});
});

describe('registering a look', () => {
	it('stores it and hands back what was stored', () => {
		const type = registerEmbedType(h, {
			agentId,
			slug: 'Slack-Message-2 ',
			name: ' Slack message ',
			spec: A_SPEC
		});

		// Lowercased and trimmed: one spelling of a slug, so an agent that types it
		// differently next session still finds its own look.
		expect(type.slug).toBe('slack-message-2');
		expect(type.name).toBe('Slack message');
		expect(type.builtIn).toBe(false);
	});

	it('replaces the look on a second call, rather than failing', () => {
		registerEmbedType(h, { agentId, slug: 'note', name: 'Note', spec: A_SPEC });
		const again = registerEmbedType(h, {
			agentId,
			slug: 'note',
			name: 'Note',
			spec: { ...A_SPEC, blocks: [{ type: 'text', value: '{{text}}' }] }
		});

		// Registering is what an agent does at the top of every run.
		expect(again.spec.blocks.map((block) => block.type)).toEqual(['text']);
		expect(listEmbedTypeViews(h).filter((type) => type.slug === 'note')).toHaveLength(1);
	});

	it('restyles the embeds already posted in it', () => {
		registerEmbedType(h, { agentId, slug: 'note', name: 'Note', spec: A_SPEC });
		const update = postUpdate(h, {
			project: slug,
			agentId,
			body: 'look',
			embeds: [{ type: 'note', data: { text: 'hello', username: 'sam' } }]
		});

		registerEmbedType(h, {
			agentId,
			slug: 'note',
			name: 'Note',
			spec: { theme: { accent: '#000000' }, blocks: [{ type: 'quote', value: '{{text}}' }] }
		});

		// The whole point of splitting the look from the instance: correcting the
		// look later fixes what is already on the timeline.
		const shown = listUpdateEmbeds(h, [update.id])[update.id];
		expect(shown[0].spec.blocks).toEqual([{ type: 'quote', value: '{{text}}' }]);
		expect(shown[0].data).toEqual({ text: 'hello', username: 'sam' });
	});

	it('refuses to let one agent redefine another agent`s look', () => {
		const other = h.agent('scribe');
		registerEmbedType(h, { agentId, slug: 'note', name: 'Note', spec: A_SPEC });

		expect(
			refusalCode(() =>
				registerEmbedType(h, { agentId: other, slug: 'note', name: 'Mine now', spec: A_SPEC })
			)
		).toBe('conflict');
	});

	it('refuses to let anybody redefine one the dashboard ships', () => {
		// A built-in that could be redefined would be a built-in that silently is
		// not: an agent could repoint `slack-message` at anything.
		expect(
			refusalCode(() =>
				registerEmbedType(h, { agentId, slug: 'slack-message', name: 'Mine', spec: A_SPEC })
			)
		).toBe('conflict');
	});

	it('refuses a slug that is not a slug', () => {
		for (const bad of [
			'',
			'Slack Message',
			'slack_message',
			'-slack',
			'slack--message',
			'a'.repeat(80)
		]) {
			expect(
				refusalCode(() => registerEmbedType(h, { agentId, slug: bad, name: 'x', spec: A_SPEC })),
				JSON.stringify(bad)
			).toBe('invalid_argument');
		}
	});
});

describe('the looks that ship', () => {
	it('covers the four sources the owner named, plus a generic one', () => {
		const slugs = listEmbedTypeViews(h)
			.filter((type) => type.builtIn)
			.map((type) => type.slug);

		expect(slugs).toEqual([
			'confluence-page',
			'github-comment',
			'jira-issue',
			'linked-page',
			'slack-message'
		]);
	});

	it('lists built-ins before an agent`s own', () => {
		registerEmbedType(h, { agentId, slug: 'aaa-note', name: 'Note', spec: A_SPEC });

		const types = listEmbedTypeViews(h);
		expect(types[types.length - 1].slug).toBe('aaa-note');
	});
});

describe('posting an embed', () => {
	it('shows up on the card, with the look it is drawn in', () => {
		const update = postUpdate(h, {
			project: slug,
			agentId,
			body: 'the release is green',
			embeds: [
				{
					type: 'slack-message',
					data: { username: 'sam', channel: '#deploys', text: 'it is green' },
					sourceUrl: 'https://example.slack.com/archives/C1/p1'
				}
			]
		});

		const shown = listUpdateEmbeds(h, [update.id])[update.id];
		expect(shown).toHaveLength(1);
		expect(shown[0].type).toBe('slack-message');
		expect(shown[0].data).toEqual({ username: 'sam', channel: '#deploys', text: 'it is green' });
		expect(shown[0].sourceUrl).toBe('https://example.slack.com/archives/C1/p1');
		// Migration 028: the Slack look carries no badge bar, because a Slack
		// message does not have one. Migration 029: it carries Slack's mark, because
		// a dashboard is a wall of quotations and a card has to say where it is
		// from. Both at once — the shape is the source, the mark is the label.
		expect(shown[0].spec.chrome).toEqual({ mark: 'slack' });
		expect(shown[0].spec.blocks[0]).toMatchObject({
			type: 'header',
			shape: 'rounded',
			layout: 'inline'
		});
	});

	it('rides on a message as readily as on a card', () => {
		const message = postMessage(h, {
			author: { kind: 'agent', agentId },
			project: slug,
			body: 'this is what they said',
			embeds: [{ type: 'github-comment', data: { username: 'sam', body: 'looks good' } }]
		});

		expect(listMessageEmbeds(h, message.id).map((embed) => embed.type)).toEqual(['github-comment']);
	});

	it('takes numbers and lists, because a model writing JSON will send them', () => {
		const update = postUpdate(h, {
			project: slug,
			agentId,
			body: 'x',
			embeds: [{ type: 'github-comment', data: { issue: 412, labels: ['bug', 'p1'] } }]
		});

		expect(listUpdateEmbeds(h, [update.id])[update.id][0].data).toEqual({
			issue: '412',
			labels: ['bug', 'p1']
		});
	});

	it('fails the whole post for an unknown look rather than dropping the embed', () => {
		expect(
			refusalCode(() =>
				postUpdate(h, {
					project: slug,
					agentId,
					body: 'x',
					embeds: [{ type: 'no-such-look', data: {} }]
				})
			)
		).toBe('invalid_argument');

		// And nothing was posted: a card missing the thing it was about is worse
		// than no card.
		expect(listUpdateEmbeds(h, [])).toEqual({});
	});

	it('refuses a source_url that is not http or https', () => {
		// It reaches an `href` in the owner's browser, so it is decided here, once,
		// before the row exists.
		for (const sourceUrl of ['javascript:alert(1)', 'data:text/html,<script>', '/relative']) {
			expect(
				refusalCode(() =>
					postUpdate(h, {
						project: slug,
						agentId,
						body: 'x',
						embeds: [{ type: 'linked-page', data: {}, sourceUrl }]
					})
				),
				sourceUrl
			).toBe('invalid_argument');
		}
	});

	it('refuses data that is not flat, because a block names a value by one word', () => {
		expect(
			refusalCode(() =>
				postUpdate(h, {
					project: slug,
					agentId,
					body: 'x',
					embeds: [{ type: 'linked-page', data: { author: { name: 'sam' } } }]
				})
			)
		).toBe('invalid_argument');
	});

	it('refuses more embeds than a card can carry', () => {
		expect(
			refusalCode(() =>
				postUpdate(h, {
					project: slug,
					agentId,
					body: 'x',
					embeds: Array.from({ length: 9 }, () => ({ type: 'linked-page', data: {} }))
				})
			)
		).toBe('invalid_argument');
	});
});

/**
 * The layout vocabulary (migration 028).
 *
 * The owner asked for the built-ins to look identical to their sources, and a
 * palette could not do it: a Slack message is a rounded-square avatar with the
 * name and the time on one line, and a GitHub comment is a circular avatar in a
 * tinted bar. These are the knobs that made that reachable — and they are enums
 * for the same reason the colours are hex literals.
 */
describe('how a look says what it looks like', () => {
	it('keeps the header`s shape, size, layout and bar', () => {
		const spec = parseEmbedSpec({
			blocks: [
				{
					type: 'header',
					title: '{{username}}',
					shape: 'rounded',
					size: 'md',
					layout: 'inline',
					bar: true
				}
			]
		});

		expect(spec.blocks[0]).toEqual({
			type: 'header',
			title: '{{username}}',
			shape: 'rounded',
			size: 'md',
			layout: 'inline',
			bar: true
		});
	});

	it('keeps the frame`s border, stripe, padding and indent', () => {
		const spec = parseEmbedSpec({
			frame: { border: false, stripe: true, padding: 'roomy', indent: true },
			blocks: [{ type: 'divider' }]
		});

		expect(spec.frame).toEqual({
			border: false,
			stripe: true,
			padding: 'roomy',
			indent: true
		});
	});

	it('defaults the frame to nothing said, so a look states only what it changes', () => {
		expect(parseEmbedSpec({ blocks: [{ type: 'divider' }] }).frame).toEqual({});
	});

	it('takes a heading, a tone, a chip style and a field layout', () => {
		const spec = parseEmbedSpec({
			blocks: [
				{ type: 'heading', value: '{{title}}', level: 2 },
				{ type: 'text', value: '{{key}}', tone: 'accent', size: 'sm' },
				{ type: 'chips', value: '{{status}}', style: 'lozenge' },
				{ type: 'fields', layout: 'inline', items: [{ label: 'Status', value: '{{status}}' }] }
			]
		});

		expect(spec.blocks).toEqual([
			{ type: 'heading', value: '{{title}}', level: 2 },
			{ type: 'text', value: '{{key}}', tone: 'accent', size: 'sm' },
			{ type: 'chips', value: '{{status}}', style: 'lozenge' },
			{ type: 'fields', layout: 'inline', items: [{ label: 'Status', value: '{{status}}' }] }
		]);
	});

	it('refuses a shape, size, tone, chip style or padding it has no class for', () => {
		const refuse = (block: unknown) => refusalCode(() => parseEmbedSpec({ blocks: [block] }));

		expect(refuse({ type: 'header', title: 'x', shape: 'hexagon' })).toBe('invalid_argument');
		expect(refuse({ type: 'header', title: 'x', size: '36px' })).toBe('invalid_argument');
		expect(refuse({ type: 'text', value: 'x', tone: '#ff0000' })).toBe('invalid_argument');
		expect(refuse({ type: 'chips', value: 'x', style: 'sticker' })).toBe('invalid_argument');
		expect(
			refusalCode(() =>
				parseEmbedSpec({ frame: { padding: '3rem' }, blocks: [{ type: 'divider' }] })
			)
		).toBe('invalid_argument');
	});

	it('clamps a heading to the two levels a card has', () => {
		const spec = parseEmbedSpec({ blocks: [{ type: 'heading', value: 'x', level: 6 }] });

		// A card is not a document, and a level nobody wrote a size for would be a
		// heading that silently rendered as another one.
		expect(spec.blocks[0]).toEqual({ type: 'heading', value: 'x', level: 1 });
	});
});

describe('the looks that ship, after migration 028', () => {
	const builtIn = (slug: string) => listEmbedTypeViews(h).find((type) => type.slug === slug)!.spec;

	it('draws Slack as a Slack message: no badge, rounded avatar, one line, indented', () => {
		const spec = builtIn('slack-message');

		// A mark, and no label: the card is shaped like Slack and marked as Slack,
		// which is not the same as having a bar across the top saying "Slack".
		expect(spec.chrome).toEqual({ mark: 'slack' });
		expect(spec.frame).toMatchObject({ stripe: false, indent: true, padding: 'roomy' });
		expect(spec.blocks[0]).toMatchObject({ shape: 'rounded', size: 'md', layout: 'inline' });
		// Slack reactions are outlined capsules, not the square tags a label is.
		expect(spec.blocks.find((block) => block.type === 'chips')).toMatchObject({ style: 'pill' });
	});

	it('draws GitHub as a comment box: a tinted bar with a circular avatar above the body', () => {
		const spec = builtIn('github-comment');

		expect(spec.blocks[0]).toMatchObject({ shape: 'circle', size: 'sm', bar: true });
		expect(spec.chrome).toEqual({ mark: 'github' });
	});

	it('draws Jira with the key above the summary and the status as a lozenge', () => {
		const spec = builtIn('jira-issue');

		expect(spec.blocks[0]).toMatchObject({ type: 'text', tone: 'accent' });
		expect(spec.blocks[1]).toMatchObject({ type: 'heading', level: 2 });
		expect(spec.blocks[2]).toMatchObject({ type: 'chips', style: 'lozenge' });
	});

	it('draws Confluence as a page: the space, then the title at page size', () => {
		const spec = builtIn('confluence-page');

		expect(spec.blocks[0]).toMatchObject({ type: 'text', tone: 'muted' });
		expect(spec.blocks[1]).toMatchObject({ type: 'heading', level: 1 });
	});
});

/**
 * Every built-in says where it came from (migration 029).
 *
 * The owner's complaint in one assertion: four white cards with nothing on them
 * naming the source. A look may say it with a mark, a label, or a picture of its
 * own — but a shipped one has to say it somehow.
 */
describe('the marks the looks carry', () => {
	it('gives every built-in a mark', () => {
		const marks = Object.fromEntries(
			listEmbedTypeViews(h)
				.filter((type) => type.builtIn)
				.map((type) => [type.slug, type.spec.chrome.mark])
		);

		expect(marks).toEqual({
			'slack-message': 'slack',
			'github-comment': 'github',
			'jira-issue': 'jira',
			'confluence-page': 'confluence',
			'linked-page': 'link'
		});
	});

	it('lets an agent name one of the marks we draw', () => {
		const type = registerEmbedType(h, {
			agentId,
			slug: 'my-linear',
			name: 'Linear issue',
			spec: { chrome: { mark: 'linear' }, blocks: [{ type: 'text', value: '{{title}}' }] }
		});

		expect(type.spec.chrome.mark).toBe('linear');
	});

	it('lets an agent bring its own picture for a source we ship no mark for', () => {
		const type = registerEmbedType(h, {
			agentId,
			slug: 'in-house',
			name: 'In-house tool',
			spec: {
				chrome: { label: 'Deploybot', image: '{{logo}}' },
				blocks: [{ type: 'text', value: '{{status}}' }]
			}
		});

		expect(type.spec.chrome.image).toBe('{{logo}}');
	});

	it('refuses a mark it has no drawing for', () => {
		// The list is closed for the same reason the colours are hex literals: the
		// renderer turns the name into a drawing it owns, so a name it does not
		// know would be a blank space nobody could explain.
		expect(
			refusalCode(() =>
				parseEmbedSpec({ chrome: { mark: 'myspace' }, blocks: [{ type: 'divider' }] })
			)
		).toBe('invalid_argument');
	});
});

/**
 * Every card type carries the same things (migration 030).
 *
 * The owner: "approval boxes cannot contain embeds, standardize the approach on
 * cards, all card types support all the same things." There was never a decision
 * that an approval should be plain text — media landed on updates, then on
 * messages, then embeds on both, and the card types nobody was looking at were
 * left behind each time.
 */
describe('embeds on every kind of card', () => {
	it('rides on an approval, which is where the owner noticed it could not', () => {
		const { request } = createRequest(h, {
			agentId,
			project: slug,
			kind: 'confirm',
			question: 'Send this to the customer?',
			embeds: [{ type: 'slack-message', data: { username: 'sam', text: 'we are on it' } }]
		});

		expect(listRequestEmbeds(h, request.id).map((embed) => embed.type)).toEqual(['slack-message']);
	});

	it('fails the whole approval for an unknown look, as a card does', () => {
		expect(
			refusalCode(() =>
				createRequest(h, {
					agentId,
					project: slug,
					kind: 'confirm',
					question: 'ok?',
					embeds: [{ type: 'no-such-look', data: {} }]
				})
			)
		).toBe('invalid_argument');
	});

	it('knows which card each one is on', () => {
		const { request } = createRequest(h, {
			agentId,
			project: slug,
			kind: 'confirm',
			question: 'ok?',
			embeds: [{ type: 'linked-page', data: { title: 'x' } }]
		});

		const [embed] = listRequestEmbeds(h, request.id);
		expect(embed).toMatchObject({ requestId: request.id, updateId: null, taskId: null });
	});
});
