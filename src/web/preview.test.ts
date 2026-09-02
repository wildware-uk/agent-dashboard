import { describe, expect, it } from 'vitest';
import { sharePreview } from './preview';
import { aMedia } from './testing';
import type { MediaView, SharedCardView } from './types';

/**
 * What a shared link unfurls to (design §7).
 *
 * Two things are being pinned. The addresses must be absolute and under the
 * share's own prefix, because a crawler fetching them has no session and no page
 * to be relative to. And only the opening of the body travels — an unfurl puts
 * this text in somebody else's chat window.
 */
const OPTIONS = { baseUrl: 'https://agents.example.com', token: 'tok-123' };

function aCard(over: Partial<SharedCardView> = {}): SharedCardView {
	return {
		update: {
			id: 'u1',
			title: 'Released 1.4',
			body: 'The release went out at 14:02.',
			level: 'success',
			createdAt: 0,
			editedAt: null
		},
		agentName: 'claude',
		projectName: 'Agent Dashboard',
		media: [],
		...over
	};
}

const image = (over: Partial<MediaView> = {}): MediaView =>
	aMedia({ id: 'm1', kind: 'image', status: 'ready', width: 1200, height: 800, ...over });

describe('the text half', () => {
	it('uses the card’s own title and an opening from its body', () => {
		expect(sharePreview(aCard(), OPTIONS)).toMatchObject({
			title: 'Released 1.4',
			description: 'The release went out at 14:02.',
			url: 'https://agents.example.com/s/tok-123'
		});
	});

	it('names the agent and project when the card has no title', () => {
		const card = aCard({ update: { ...aCard().update, title: null } });

		expect(sharePreview(card, OPTIONS).title).toBe('claude in Agent Dashboard');
	});

	it('falls back to the agent alone when there is no project either', () => {
		const card = aCard({ update: { ...aCard().update, title: null }, projectName: null });

		expect(sharePreview(card, OPTIONS).title).toBe('An update from claude');
	});

	it('flattens the markdown rather than pasting syntax into somebody’s chat', () => {
		const card = aCard({ update: { ...aCard().update, body: '## Done\n- [a link](http://x)' } });

		expect(sharePreview(card, OPTIONS).description).toBe('Done a link');
	});

	it('carries an opening, not the whole body', () => {
		const card = aCard({ update: { ...aCard().update, body: `${'word '.repeat(200)}` } });

		expect(sharePreview(card, OPTIONS).description.length).toBeLessThanOrEqual(201);
	});

	it('repeats the title rather than leaving the summary blank', () => {
		const card = aCard({ update: { ...aCard().update, body: '   ' } });

		expect(sharePreview(card, OPTIONS).description).toBe('Released 1.4');
	});

	it('trims a trailing slash off the origin rather than doubling it', () => {
		expect(sharePreview(aCard(), { ...OPTIONS, baseUrl: 'https://agents.example.com/' }).url).toBe(
			'https://agents.example.com/s/tok-123'
		);
	});
});

describe('the picture half', () => {
	it('points at the first image, absolutely, under the share’s own prefix', () => {
		const card = aCard({ media: [image()] });

		expect(sharePreview(card, OPTIONS)).toMatchObject({
			image: 'https://agents.example.com/s/tok-123/media/m1/thumb-1600',
			imageAlt: 'Released 1.4',
			imageWidth: 1200,
			imageHeight: 800
		});
	});

	it('falls back to the original when the pipeline made no large thumbnail', () => {
		const card = aCard({ media: [image({ variants: ['original'] })] });

		expect(sharePreview(card, OPTIONS).image).toBe(
			'https://agents.example.com/s/tok-123/media/m1/original'
		);
	});

	it('offers no image for a card that has none', () => {
		expect(sharePreview(aCard(), OPTIONS).image).toBeUndefined();
	});

	it('ignores media the pipeline has not finished with', () => {
		const card = aCard({ media: [image({ status: 'pending', variants: [] })] });

		expect(sharePreview(card, OPTIONS).image).toBeUndefined();
	});

	it('shows a video’s poster frame, and offers the file itself', () => {
		const card = aCard({
			media: [
				aMedia({
					id: 'v1',
					kind: 'video',
					status: 'ready',
					mime: 'video/quicktime',
					variants: ['original', 'poster', 'video']
				})
			]
		});

		expect(sharePreview(card, OPTIONS)).toMatchObject({
			image: 'https://agents.example.com/s/tok-123/media/v1/poster',
			video: 'https://agents.example.com/s/tok-123/media/v1/video',
			videoType: 'video/mp4'
		});
	});

	it('states the stored type when there is no transcode to promise mp4 for', () => {
		const card = aCard({
			media: [
				aMedia({
					id: 'v1',
					kind: 'video',
					status: 'ready',
					mime: 'video/mp4',
					variants: ['original']
				})
			]
		});

		expect(sharePreview(card, OPTIONS)).toMatchObject({
			video: 'https://agents.example.com/s/tok-123/media/v1/original',
			videoType: 'video/mp4'
		});
	});

	it('prefers a real image over a video’s poster when the card has both', () => {
		const card = aCard({
			media: [
				aMedia({ id: 'v1', kind: 'video', status: 'ready', variants: ['poster', 'video'] }),
				image({ id: 'm2' })
			]
		});

		expect(sharePreview(card, OPTIONS).image).toBe(
			'https://agents.example.com/s/tok-123/media/m2/thumb-1600'
		);
	});
});
