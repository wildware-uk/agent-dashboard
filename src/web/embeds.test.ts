import { describe, expect, it } from 'vitest';
import {
	bodyIndent,
	chipsOf,
	fill,
	frameClass,
	fontClass,
	imageSrc,
	link,
	resolveBlocks,
	resolveChrome,
	themeStyle,
	withSource
} from './embeds';
import type { EmbedSpec } from './types';

/**
 * The pure decisions behind an embed (migration 027).
 *
 * The rule with teeth is "a block whose values all come out empty is not drawn".
 * It is what lets one registered look cover a Slack message that has reactions
 * on it and one that does not, which is the difference between the feature being
 * dynamic and the feature being five hardcoded cards.
 */
const spec = (
	blocks: EmbedSpec['blocks'],
	theme: EmbedSpec['theme'] = {},
	chrome: EmbedSpec['chrome'] = {},
	frame: EmbedSpec['frame'] = {}
): EmbedSpec => ({ theme, chrome, frame, blocks });

describe('filling a look in', () => {
	it('replaces a placeholder with the value under that name', () => {
		expect(fill('{{username}} said', { username: 'sam' })).toEqual({
			text: 'sam said',
			filled: true
		});
	});

	it('joins a list, because only chips wants it back as one', () => {
		expect(fill('{{labels}}', { labels: ['bug', 'p1'] }).text).toBe('bug, p1');
	});

	it('counts literal text as filled, so a fixed label is not dropped', () => {
		// "View in Slack" beside a missing URL is still something to say.
		expect(fill('View in Slack', {})).toEqual({ text: 'View in Slack', filled: true });
	});

	it('reports a placeholder that found nothing', () => {
		expect(fill('{{missing}}', {})).toEqual({ text: '', filled: false });
		expect(fill('by {{missing}}', {})).toEqual({ text: 'by', filled: false });
	});
});

describe('which blocks get drawn', () => {
	it('drops one whose only placeholder came out empty', () => {
		const blocks = resolveBlocks(
			spec([
				{ type: 'text', value: '{{text}}' },
				{ type: 'chips', value: '{{reactions}}' }
			]),
			{ text: 'hello' }
		);

		expect(blocks).toEqual([{ type: 'text', value: 'hello' }]);
	});

	it('keeps a header that has words, and drops one that has only an avatar', () => {
		const layout = spec([
			{ type: 'header', avatar: '{{avatar}}', title: '{{username}}', meta: '{{time}}' }
		]);

		expect(resolveBlocks(layout, { username: 'sam', avatar: 'x' })).toEqual([
			{ type: 'header', avatar: 'x', title: 'sam' }
		]);
		// A floating picture with no name beside it is not a header.
		expect(resolveBlocks(layout, { avatar: 'x' })).toEqual([]);
	});

	it('drops the rows of a field table that have no value', () => {
		const blocks = resolveBlocks(
			spec([
				{
					type: 'fields',
					items: [
						{ label: 'Status', value: '{{status}}' },
						{ label: 'Assignee', value: '{{assignee}}' }
					]
				}
			]),
			{ status: 'In progress' }
		);

		// "Assignee —" is worse than no row at all.
		expect(blocks).toEqual([
			{ type: 'fields', items: [{ label: 'Status', value: 'In progress' }] }
		]);
	});

	it('drops a whole field table when nothing in it arrived', () => {
		const blocks = resolveBlocks(
			spec([{ type: 'fields', items: [{ label: 'Status', value: '{{status}}' }] }]),
			{}
		);

		expect(blocks).toEqual([]);
	});

	it('keeps a footer that is only a label, and drops one that is nothing', () => {
		const layout = spec([{ type: 'footer', value: 'View in Slack', url: '{{permalink}}' }]);

		expect(resolveBlocks(layout, {})).toEqual([{ type: 'footer', value: 'View in Slack' }]);
		expect(resolveBlocks(spec([{ type: 'footer', url: '{{permalink}}' }]), {})).toEqual([]);
	});

	it('drops a rule that separates nothing', () => {
		const blocks = resolveBlocks(
			spec([
				{ type: 'divider' },
				{ type: 'text', value: '{{a}}' },
				{ type: 'divider' },
				{ type: 'divider' },
				{ type: 'text', value: '{{b}}' },
				{ type: 'divider' }
			]),
			{ a: 'one', b: 'two' }
		);

		expect(blocks.map((block) => block.type)).toEqual(['text', 'divider', 'text']);
	});

	it('drops a picture whose source resolves to nowhere safe', () => {
		expect(resolveBlocks(spec([{ type: 'image', value: '{{shot}}' }]), { shot: 'x' })).toEqual([]);
		expect(
			resolveBlocks(spec([{ type: 'image', value: '{{shot}}' }]), {
				shot: 'javascript:alert(1)'
			})
		).toEqual([]);
	});
});

describe('the badge along the top', () => {
	it('is filled from the instance, so one look can name several sources', () => {
		expect(
			resolveChrome(spec([], {}, { label: '{{site}}', icon: '🔗' }), { site: 'Linear' })
		).toEqual({ label: 'Linear', icon: '🔗' });
	});

	it('is absent when a look asked for none', () => {
		expect(resolveChrome(spec([]), {})).toBeNull();
	});
});

describe('the palette', () => {
	it('becomes custom properties, and only the ones the look set', () => {
		expect(themeStyle({ accent: '#611f69', radius: 'lg' })).toBe(
			'--embed-accent: #611f69; --embed-radius: 0.875rem'
		);
	});

	it('is empty for a look that named no colours, so the dashboard`s own show through', () => {
		expect(themeStyle({})).toBe('');
	});

	it('turns a font name into a class rather than a stack', () => {
		expect(fontClass({ font: 'serif' })).toBe('font-serif');
		expect(fontClass({ font: 'mono' })).toBe('font-mono');
		expect(fontClass({})).toBe('font-sans');
	});
});

describe('pictures and links', () => {
	it('turns an uploaded media id into this deployment`s own address', () => {
		expect(imageSrc('01M0EMBED00000000000000001')).toBe(
			'/media/01M0EMBED00000000000000001/thumb-640'
		);
	});

	it('takes an https URL as given, because a quoted avatar is one', () => {
		expect(imageSrc('https://avatars.example.com/sam.png')).toBe(
			'https://avatars.example.com/sam.png'
		);
	});

	it('resolves anything else to nothing', () => {
		// The second line of defence: the server has refused these too, and this is
		// the value that actually reaches an `src`.
		for (const value of [
			'javascript:alert(1)',
			'data:image/svg+xml,<svg>',
			'/local.png',
			'http://x/y',
			''
		]) {
			expect(imageSrc(value), value).toBeNull();
		}
	});

	it('allows only http and https in a link', () => {
		expect(link('https://example.com')).toBe('https://example.com');
		expect(link('http://example.com')).toBe('http://example.com');
		expect(link('javascript:alert(1)')).toBeNull();
		expect(link('mailto:a@b.c')).toBeNull();
	});
});

describe('chips', () => {
	it('splits one string, and ignores the blanks', () => {
		expect(chipsOf('bug, p1 ,, needs-triage')).toEqual(['bug', 'p1', 'needs-triage']);
		expect(chipsOf('   ')).toEqual([]);
	});
});

describe('where it came from', () => {
	it('is offered to the look as a value, so a footer can link it', () => {
		expect(withSource({ text: 'x' }, 'https://example.com/a')).toEqual({
			text: 'x',
			source_url: 'https://example.com/a'
		});
	});

	it('does not overwrite one the poster sent themselves', () => {
		expect(withSource({ source_url: 'https://mine' }, 'https://theirs').source_url).toBe(
			'https://mine'
		);
	});

	it('changes nothing when the poster said nowhere', () => {
		const data = { text: 'x' };
		expect(withSource(data, null)).toBe(data);
	});
});

/**
 * The frame and the indent (migration 028).
 *
 * The indent is the one that reads as Slack or does not: Slack lines its text up
 * under the *name*, not under the card's edge, and a card that did not was the
 * thing the owner was looking at when they said these should be identical to
 * their sources.
 */
describe('the frame', () => {
	it('names what to draw, with sensible defaults', () => {
		expect(frameClass({})).toBe('embed embed-pad-normal');
		expect(frameClass({ border: false, stripe: true, padding: 'roomy' })).toBe(
			'embed embed-borderless embed-striped embed-pad-roomy'
		);
	});
});

describe('lining the body up under the name', () => {
	const withHeader = (frame: EmbedSpec['frame'], header: EmbedSpec['blocks'][number]) => {
		const layout = spec([header, { type: 'text', value: 'hello' }], {}, {}, frame);
		return bodyIndent(layout, resolveBlocks(layout, { avatar: 'https://a/b.png' }));
	};

	it('clears the avatar the header actually asked for', () => {
		expect(
			withHeader(
				{ indent: true },
				{ type: 'header', avatar: '{{avatar}}', title: 'sam', size: 'md' }
			)
		).toBe('calc(2.25rem + 0.5rem)');
		expect(
			withHeader(
				{ indent: true },
				{ type: 'header', avatar: '{{avatar}}', title: 'sam', size: 'sm' }
			)
		).toBe('calc(1.25rem + 0.5rem)');
	});

	it('does not indent when the look did not ask', () => {
		expect(withHeader({}, { type: 'header', avatar: '{{avatar}}', title: 'sam' })).toBeNull();
	});

	it('does not indent past a picture that never arrived', () => {
		// Otherwise a message from somebody with no avatar is a margin with no
		// reason for being there.
		const layout = spec(
			[
				{ type: 'header', avatar: '{{avatar}}', title: 'sam' },
				{ type: 'text', value: 'hello' }
			],
			{},
			{},
			{ indent: true }
		);
		expect(bodyIndent(layout, resolveBlocks(layout, {}))).toBeNull();
	});
});
