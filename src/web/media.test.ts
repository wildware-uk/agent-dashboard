import { VARIANTS } from '$media';
import { describe, expect, it } from 'vitest';
import {
	CELL_RATIO,
	DEFAULT_RATIO,
	MAX_RATIO,
	MIN_RATIO,
	durationLabel,
	gridColumns,
	intrinsic,
	isViewable,
	mediaLabel,
	mediaUrl,
	posterSrc,
	thumbSrc,
	thumbSrcset,
	tileRatio,
	viewSrc,
	videoSrc
} from './media';
import { aMedia } from './testing';
import type { MediaVariant } from './types';

/**
 * The pure half of the media UI: addresses, boxes and labels.
 *
 * All of it is here rather than in the components because every one of these is
 * a decision a browser test would only observe indirectly — and because the box
 * a cell reserves is the whole of "no layout shift", which is worth asserting on
 * numbers rather than on rendered pixels.
 */
describe('addresses', () => {
	it('builds the one address media is served at (design §6)', () => {
		expect(mediaUrl('m1', 'thumb-640')).toBe('/media/m1/thumb-640');
	});

	it('knows exactly the variants the server serves, and no others', () => {
		// The copy that would otherwise rot: `src/web` may not import `$media`
		// (design §2), so the wire vocabulary is re-declared there — and pinned here.
		expect([...VARIANTS].sort()).toEqual(
			['original', 'thumb-640', 'thumb-1600', 'poster', 'video'].sort()
		);
	});
});

describe('the box a cell reserves', () => {
	it('takes a lone image`s shape from the stored dimensions', () => {
		expect(tileRatio(aMedia({ width: 1600, height: 800 }), 1)).toBe(2);
	});

	it('falls back to a default when the pipeline has not measured it yet', () => {
		const pending = aMedia({ status: 'pending', width: null, height: null, variants: [] });

		expect(tileRatio(pending, 1)).toBe(DEFAULT_RATIO);
	});

	it('clamps a shape nothing sensible could be laid out at', () => {
		expect(tileRatio(aMedia({ width: 20, height: 4000 }), 1)).toBe(MIN_RATIO);
		expect(tileRatio(aMedia({ width: 4000, height: 20 }), 1)).toBe(MAX_RATIO);
	});

	it('uses one uniform cell shape once there is more than one item', () => {
		// Several updates carry three or four shots. Letting each cell keep its own
		// shape makes a ragged grid; the point of the box is that it is decided
		// before any byte loads, and a uniform cell is decided for every state.
		expect(tileRatio(aMedia({ width: 1600, height: 800 }), 3)).toBe(CELL_RATIO);
		expect(tileRatio(aMedia({ status: 'pending', width: null, height: null }), 3)).toBe(CELL_RATIO);
	});

	it('ignores dimensions that are not a real shape', () => {
		expect(tileRatio(aMedia({ width: 0, height: 0 }), 1)).toBe(DEFAULT_RATIO);
		expect(tileRatio(aMedia({ width: -4, height: 3 }), 1)).toBe(DEFAULT_RATIO);
	});

	it('hands the img its intrinsic size when it is known, and nothing when it is not', () => {
		expect(intrinsic(aMedia({ width: 1200, height: 800 }))).toEqual({ width: 1200, height: 800 });
		expect(intrinsic(aMedia({ width: null, height: null }))).toBeNull();
	});

	it('lays a handful of items out in a grid rather than a column', () => {
		expect([1, 2, 3, 4, 5, 6, 7].map(gridColumns)).toEqual([1, 2, 3, 2, 3, 3, 3]);
	});
});

describe('what a ready image is rendered from', () => {
	it('shows the small thumbnail and offers the large one to a wide screen', () => {
		const item = aMedia({ id: 'm1' });

		expect(thumbSrc(item)).toBe('/media/m1/thumb-640');
		expect(thumbSrcset(item)).toBe('/media/m1/thumb-640 640w, /media/m1/thumb-1600 1600w');
	});

	it('offers no srcset when only one thumbnail exists', () => {
		expect(thumbSrcset(aMedia({ variants: ['original', 'thumb-640'] }))).toBeUndefined();
	});

	it('falls back to the original when there is no thumbnail at all', () => {
		// A ready row with no thumbnail row is not a shape the pipeline produces,
		// but serving the original beats rendering a broken image if it ever does.
		expect(thumbSrc(aMedia({ id: 'm1', variants: ['original'] }))).toBe('/media/m1/original');
	});

	it('views the large thumbnail full-size, and the original if there is none', () => {
		expect(viewSrc(aMedia({ id: 'm1' }))).toBe('/media/m1/thumb-1600');
		expect(viewSrc(aMedia({ id: 'm1', variants: ['original', 'thumb-640'] }))).toBe(
			'/media/m1/original'
		);
	});

	it('renders nothing from an item that is not ready', () => {
		expect(thumbSrc(aMedia({ status: 'pending', variants: ['original'] }))).toBeNull();
		expect(thumbSrc(aMedia({ status: 'failed', variants: [] }))).toBeNull();
		expect(viewSrc(aMedia({ status: 'failed', variants: [] }))).toBeNull();
	});
});

describe('what a ready video is played from', () => {
	const clip = (variants: MediaVariant[]) =>
		aMedia({ id: 'v1', kind: 'video', mime: 'video/mp4', durationMs: 7400, variants });

	it('plays the transcode when the source needed one', () => {
		expect(videoSrc(clip(['original', 'poster', 'video']))).toBe('/media/v1/video');
	});

	it('plays the original when it was already web-playable', () => {
		// `src/media/derive.ts` skips the transcode for an h264 mp4, so there is no
		// `video` row to find and the original is the only playable source.
		expect(videoSrc(clip(['original', 'poster']))).toBe('/media/v1/original');
	});

	it('shows the poster frame first, so nothing downloads until it is played', () => {
		expect(posterSrc(clip(['original', 'poster']))).toBe('/media/v1/poster');
		expect(posterSrc(clip(['original']))).toBeNull();
	});

	it('never plays anything from an item that is not ready', () => {
		expect(videoSrc(aMedia({ kind: 'video', status: 'pending', variants: [] }))).toBeNull();
		expect(videoSrc(aMedia({ kind: 'video', status: 'failed', variants: [] }))).toBeNull();
	});

	it('says how long the clip is, when the pipeline measured it', () => {
		expect(durationLabel(7400)).toBe('0:07');
		expect(durationLabel(83_000)).toBe('1:23');
		expect(durationLabel(3_723_000)).toBe('62:03');
		expect(durationLabel(null)).toBeNull();
		expect(durationLabel(0)).toBeNull();
	});
});

describe('what the lightbox holds', () => {
	it('takes the ready images', () => {
		expect(isViewable(aMedia())).toBe(true);
	});

	it('leaves out anything with no full-size asset behind it', () => {
		expect(isViewable(aMedia({ status: 'pending', variants: [] }))).toBe(false);
		expect(isViewable(aMedia({ status: 'failed', variants: [] }))).toBe(false);
	});

	it('leaves out video, which plays where it sits', () => {
		expect(isViewable(aMedia({ kind: 'video', variants: ['original', 'poster', 'video'] }))).toBe(
			false
		);
	});
});

describe('what a screen reader is told', () => {
	it('numbers the items, because the file names are not the browser`s to know', () => {
		// The agent's filename is stored nowhere at all (`src/media/paths.ts`), so
		// a position in the grid is the only honest description there is.
		expect(mediaLabel(aMedia(), 0, 3)).toBe('Image 1 of 3');
		expect(mediaLabel(aMedia({ kind: 'video' }), 2, 3)).toBe('Video 3 of 3');
	});

	it('says what is happening to an item that has nothing to show', () => {
		expect(mediaLabel(aMedia({ status: 'pending' }), 0, 1)).toBe('Image 1 of 1, still processing');
		expect(mediaLabel(aMedia({ status: 'failed' }), 0, 1)).toBe(
			'Image 1 of 1, could not be processed'
		);
	});
});
