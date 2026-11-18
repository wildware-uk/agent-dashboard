import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Embed from './Embed.svelte';
import type { EmbedSpec, EmbedView } from './types';

/**
 * An embed in a real browser (migration 027).
 *
 * The assertion that matters most is the one about markup: an embed is drawn
 * from a description an agent supplied, on the dashboard's own origin, so what
 * is being pinned here is that a value containing a tag arrives as *text*. If
 * that ever stops being true, "agents may style an embed" becomes "agents may
 * run script in the owner's session".
 */
const anEmbed = (spec: EmbedSpec, data: EmbedView['data'] = {}): EmbedView => ({
	id: 'e1',
	updateId: 'u1',
	messageId: null,
	requestId: null,
	taskId: null,
	type: 'slack-message',
	typeName: 'Slack message',
	spec,
	data,
	sourceUrl: null,
	createdAt: 0
});

const SLACK: EmbedSpec = {
	theme: { accent: '#611f69', background: '#ffffff', foreground: '#1d1c1d', radius: 'md' },
	chrome: { label: 'Slack', icon: '💬' },
	frame: {},
	blocks: [
		{ type: 'header', avatar: '{{avatar}}', title: '{{username}}', subtitle: '{{channel}}' },
		{ type: 'markdown', value: '{{text}}' },
		{ type: 'chips', value: '{{reactions}}' },
		{ type: 'footer', value: 'View in Slack', url: '{{permalink}}' }
	]
};

describe('drawing an embed', () => {
	it('draws the blocks the look names, with the values it was given', async () => {
		const { getByText, getByRole } = render(Embed, {
			embed: anEmbed(SLACK, {
				username: 'sam',
				channel: '#deploys',
				text: 'the release is **green**',
				reactions: ['🎉', '👍'],
				permalink: 'https://example.slack.com/archives/C1/p1'
			})
		});

		await expect.element(getByText('sam')).toBeInTheDocument();
		await expect.element(getByText('#deploys')).toBeInTheDocument();
		await expect.element(getByText('Slack', { exact: true })).toBeInTheDocument();
		// Markdown really is markdown inside an embed.
		await expect.element(getByText('green')).toBeInTheDocument();
		await expect
			.element(getByRole('link', { name: 'View in Slack' }))
			.toHaveAttribute('href', 'https://example.slack.com/archives/C1/p1');
	});

	it('renders an agent`s value as text, never as markup', async () => {
		render(Embed, { embed: anEmbed(SLACK, { username: '<img src=x onerror=alert(1)>' }) });

		// The whole security argument, in one assertion: no element came out of it.
		expect(document.querySelector('[data-embed] img')).toBeNull();
		expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
	});

	it('leaves out the blocks whose values did not arrive', async () => {
		render(Embed, { embed: anEmbed(SLACK, { username: 'sam', text: 'hello' }) });

		// No reactions were sent, so there is no empty pill row.
		expect(document.querySelectorAll('[data-embed] li')).toHaveLength(0);
		// And no permalink, so the footer is a line of text rather than a link.
		expect(document.querySelector('[data-embed] a')).toBeNull();
	});

	it('paints the look`s palette as custom properties on the card', async () => {
		render(Embed, { embed: anEmbed(SLACK, { username: 'sam' }) });

		const card = document.querySelector('[data-embed]') as HTMLElement;
		expect(card.style.getPropertyValue('--embed-accent')).toBe('#611f69');
		expect(card.style.getPropertyValue('--embed-background')).toBe('#ffffff');
		expect(card.getAttribute('data-embed-type')).toBe('slack-message');
	});

	it('renders nothing at all when no block survived', async () => {
		// Every block here is a placeholder and nothing was sent. A card that is
		// only chrome is a badge floating over an empty box.
		render(Embed, {
			embed: anEmbed({
				theme: {},
				chrome: { label: 'Slack' },
				frame: {},
				blocks: [
					{ type: 'text', value: '{{text}}' },
					{ type: 'chips', value: '{{reactions}}' }
				]
			})
		});

		expect(document.querySelector('[data-embed]')).toBeNull();
	});

	it('opens an agent`s link with the opener and the referrer cut', async () => {
		const { getByRole } = render(Embed, {
			embed: anEmbed(SLACK, { username: 'sam', permalink: 'https://example.com/x' })
		});

		const link = getByRole('link', { name: 'View in Slack' });
		await expect.element(link).toHaveAttribute('target', '_blank');
		await expect.element(link).toHaveAttribute('rel', 'noreferrer noopener');
	});

	it('shows a field table, a quote and code in the faces they belong in', async () => {
		const { getByText } = render(Embed, {
			embed: anEmbed(
				{
					theme: {},
					chrome: {},
					frame: {},
					blocks: [
						{ type: 'fields', items: [{ label: 'Status', value: '{{status}}' }] },
						{ type: 'quote', value: '{{quote}}' },
						{ type: 'code', value: '{{diff}}', language: 'diff' }
					]
				},
				{ status: 'In progress', quote: 'they said this', diff: '- old\n+ new' }
			)
		});

		await expect.element(getByText('Status')).toBeInTheDocument();
		await expect.element(getByText('In progress')).toBeInTheDocument();
		await expect.element(getByText('they said this')).toBeInTheDocument();
		expect(document.querySelector('[data-embed] pre code')?.textContent).toBe('- old\n+ new');
	});
});

describe('where an embed came from', () => {
	it('makes the badge along the top the link to it', async () => {
		const { getByRole } = render(Embed, {
			embed: {
				...anEmbed(SLACK, { username: 'sam' }),
				sourceUrl: 'https://example.slack.com/archives/C1/p1'
			}
		});

		// Otherwise a poster that said where it came from said it into a column
		// nobody reads.
		await expect
			.element(getByRole('link', { name: 'Slack' }))
			.toHaveAttribute('href', 'https://example.slack.com/archives/C1/p1');
	});

	it('is reachable from a look as {{source_url}}', async () => {
		const { getByRole } = render(Embed, {
			embed: {
				...anEmbed(
					{
						theme: {},
						chrome: {},
						frame: {},
						blocks: [{ type: 'footer', value: 'Open the original', url: '{{source_url}}' }]
					},
					{}
				),
				sourceUrl: 'https://example.com/a'
			}
		});

		await expect
			.element(getByRole('link', { name: 'Open the original' }))
			.toHaveAttribute('href', 'https://example.com/a');
	});
});

/**
 * The layout a look asked for (migration 028).
 *
 * Every one of these is a closed enum turned into a class this component wrote,
 * which is the thing that keeps "an agent may lay out an embed" from being "an
 * agent may write CSS on the dashboard's origin".
 */
describe('drawing a look`s layout', () => {
	const shaped = (spec: EmbedSpec, data: EmbedView['data'] = {}) =>
		render(Embed, { embed: anEmbed(spec, data) });

	it('gives the avatar the shape and size the look named', async () => {
		shaped(
			{
				theme: {},
				chrome: {},
				frame: {},
				blocks: [
					{
						type: 'header',
						avatar: '{{avatar}}',
						title: 'sam',
						shape: 'circle',
						size: 'sm',
						layout: 'inline',
						bar: true
					}
				]
			},
			{ avatar: 'https://example.com/sam.png' }
		);

		const header = document.querySelector('[data-embed] .embed-header') as HTMLElement;
		expect(header.className).toContain('embed-avatar-circle');
		expect(header.className).toContain('embed-header-sm');
		expect(header.className).toContain('embed-header-bar');
	});

	it('lines the body up under the name when the look asked and there is an avatar', async () => {
		shaped(
			{
				theme: {},
				chrome: {},
				frame: { indent: true },
				blocks: [
					{ type: 'header', avatar: '{{avatar}}', title: 'sam', size: 'md' },
					{ type: 'text', value: 'hello' }
				]
			},
			{ avatar: 'https://example.com/sam.png' }
		);

		const body = document.querySelector('[data-embed] .embed-body') as HTMLElement;
		expect(body.style.getPropertyValue('--embed-indent')).toBe('calc(2.25rem + 0.5rem)');
	});

	it('names the frame it was told to draw', async () => {
		shaped({
			theme: {},
			chrome: {},
			frame: { border: false, stripe: true, padding: 'roomy' },
			blocks: [{ type: 'text', value: 'hello' }]
		});

		const card = document.querySelector('[data-embed]') as HTMLElement;
		expect(card.className).toContain('embed-borderless');
		expect(card.className).toContain('embed-striped');
		expect(card.className).toContain('embed-pad-roomy');
	});

	it('draws a heading and a chip in the shapes the look named', async () => {
		const { getByText } = shaped({
			theme: {},
			chrome: {},
			frame: {},
			blocks: [
				{ type: 'heading', value: 'Any file may be uploaded', level: 2 },
				{ type: 'chips', value: 'Done', style: 'lozenge' }
			]
		});

		await expect.element(getByText('Any file may be uploaded')).toBeInTheDocument();
		expect(document.querySelector('[data-embed] h4.embed-heading-2')).not.toBeNull();
		expect(document.querySelector('[data-embed] .embed-chip-lozenge')?.textContent).toBe('Done');
	});
});

/**
 * The source's mark (migration 029).
 *
 * The owner asked for it and the point is that it does not depend on a badge: a
 * look shaped exactly like a Slack message, with no bar across the top, still
 * has to say that it is Slack.
 */
describe('saying where a card came from', () => {
	it('draws the mark even when the look has no badge at all', async () => {
		render(Embed, {
			embed: anEmbed(
				{
					theme: {},
					chrome: { mark: 'slack' },
					frame: {},
					blocks: [{ type: 'text', value: '{{text}}' }]
				},
				{ text: 'it is green' }
			)
		});

		const brand = document.querySelector('[data-embed] [data-embed-mark]');
		expect(brand?.getAttribute('data-embed-mark')).toBe('slack');
		expect(brand?.querySelector('svg')?.getAttribute('aria-label')).toBe('slack');
	});

	it('names it with the look`s label when there is one', async () => {
		render(Embed, {
			embed: anEmbed({
				theme: {},
				chrome: { mark: 'github', label: 'GitHub' },
				frame: {},
				blocks: [{ type: 'text', value: 'x' }]
			})
		});

		expect(
			document.querySelector('[data-embed] [data-embed-mark] svg')?.getAttribute('aria-label')
		).toBe('GitHub');
	});

	it('prefers a picture the look brought over the one we draw', async () => {
		render(Embed, {
			embed: anEmbed(
				{
					theme: {},
					chrome: { mark: 'link', label: 'Deploybot', image: '{{logo}}' },
					frame: {},
					blocks: [{ type: 'text', value: 'x' }]
				},
				{ logo: 'https://example.com/logo.png' }
			)
		});

		const brand = document.querySelector('[data-embed] [data-embed-mark]');
		expect(brand?.getAttribute('data-embed-mark')).toBe('image');
		expect(brand?.querySelector('img')?.getAttribute('src')).toBe('https://example.com/logo.png');
	});

	it('falls back to the drawn mark when the picture is not a safe source', async () => {
		render(Embed, {
			embed: anEmbed(
				{
					theme: {},
					chrome: { mark: 'jira', image: '{{logo}}' },
					frame: {},
					blocks: [{ type: 'text', value: 'x' }]
				},
				{ logo: 'javascript:alert(1)' }
			)
		});

		expect(
			document.querySelector('[data-embed] [data-embed-mark]')?.getAttribute('data-embed-mark')
		).toBe('jira');
	});

	it('draws nothing when a look named no mark', async () => {
		render(Embed, {
			embed: anEmbed({
				theme: {},
				chrome: {},
				frame: {},
				blocks: [{ type: 'text', value: 'x' }]
			})
		});

		expect(document.querySelector('[data-embed] [data-embed-mark]')).toBeNull();
	});
});
