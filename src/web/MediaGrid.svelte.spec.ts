import { userEvent } from '@vitest/browser/context';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import MediaGrid from './MediaGrid.svelte';
import { CELL_RATIO, mediaLabel } from './media';
import { aMedia } from './testing';
import type { MediaVariant } from './types';

/**
 * The media grid in a real browser (design §7).
 *
 * The four states a card's media can be in are all here, because three of them
 * are what a shortcut skips: a placeholder that never swaps, a failure that
 * renders as a broken image, and a video that downloads itself before anyone
 * asks to watch it.
 */
const tile = (id: string) => document.querySelector(`[data-media-tile="${id}"]`) as HTMLElement;

/**
 * The cell's reserved shape, as a number.
 *
 * Chromium normalises `aspect-ratio: 1.5` to `1.5 / 1`, so the assertion has to
 * divide rather than parse a float.
 */
function box(id: string): number {
	const [width, height = '1'] = tile(id).style.aspectRatio.split('/');
	return Number(width) / Number(height);
}

/**
 * Open a cell the way a mouse does: focus, then click.
 *
 * A real Playwright click cannot be used here. No stylesheet is loaded in a
 * component test (see `Shell.svelte.spec.ts`), so every Tailwind class is inert
 * and an `<img width="1200">` lays itself out 1200px wide inside a 414px test
 * viewport — the centre of the cell, which is where a driven click lands, is off
 * screen. The keyboard assertions below are real key presses, because those do
 * not depend on where anything is.
 */
async function openTile(id: string): Promise<void> {
	const control = tile(id).querySelector('button') as HTMLButtonElement;
	control.focus();
	control.click();
	await tick();
}

describe('the grid', () => {
	it('renders nothing at all for an update with no media', async () => {
		render(MediaGrid, { items: [] });

		expect(document.querySelector('[data-media-grid]')).toBeNull();
	});

	it('reserves a lone image`s box from the stored dimensions, before it loads', async () => {
		// The whole of "no layout shift": 1200x800 is known from the row, so the
		// space is taken at first paint rather than when the bytes arrive.
		render(MediaGrid, { items: [aMedia({ id: 'm1', width: 1200, height: 800 })] });

		expect(box('m1')).toBeCloseTo(1.5, 3);
	});

	it('lays several out in columns with one uniform cell shape', async () => {
		const items = [1, 2, 3].map((n) => aMedia({ id: `m${n}`, width: 100 * n, height: 700 }));

		render(MediaGrid, { items });

		const grid = document.querySelector('[data-media-grid]') as HTMLElement;
		expect(grid.dataset.mediaCount).toBe('3');
		expect(grid.style.gridTemplateColumns).toContain('repeat(3');
		// Wildly different shapes, one grid: a staircase of cells is not a grid.
		for (const id of ['m1', 'm2', 'm3']) {
			expect(box(id)).toBeCloseTo(CELL_RATIO, 3);
		}
	});
});

describe('a ready image', () => {
	it('renders the thumbnail, offers the large one, and states its intrinsic size', async () => {
		render(MediaGrid, { items: [aMedia({ id: 'm1', width: 1200, height: 800 })] });

		const img = document.querySelector('img') as HTMLImageElement;
		expect(img.getAttribute('src')).toBe('/media/m1/thumb-640');
		expect(img.getAttribute('srcset')).toBe('/media/m1/thumb-640 640w, /media/m1/thumb-1600 1600w');
		expect(img.getAttribute('width')).toBe('1200');
		expect(img.getAttribute('height')).toBe('800');
		expect(img.getAttribute('loading')).toBe('lazy');
	});

	it('is a control, because it opens the lightbox', async () => {
		const screen = render(MediaGrid, { items: [aMedia({ id: 'm1' })] });

		await expect.element(screen.getByRole('button', { name: 'Image 1 of 1' })).toBeInTheDocument();
	});
});

describe('media the pipeline has not finished with', () => {
	it('renders a placeholder that says so, and no image element at all', async () => {
		const pending = aMedia({
			id: 'm1',
			status: 'pending',
			width: null,
			height: null,
			variants: []
		});

		const screen = render(MediaGrid, { items: [pending] });

		await expect.element(screen.getByText('Processing…')).toBeInTheDocument();
		// Not an <img> with no src, which is a broken image in every browser.
		expect(document.querySelector('img')).toBeNull();
		expect(tile('m1').dataset.mediaState).toBe('pending');
	});

	it('still reserves a box, so the card does not resize when it swaps', async () => {
		const pending = aMedia({
			id: 'm1',
			status: 'pending',
			width: null,
			height: null,
			variants: []
		});

		render(MediaGrid, { items: [pending] });

		expect(box('m1')).toBeGreaterThan(0);
	});

	it('describes the placeholder to a screen reader as what it is', async () => {
		const pending = aMedia({
			id: 'm1',
			status: 'pending',
			width: null,
			height: null,
			variants: []
		});

		const screen = render(MediaGrid, { items: [pending] });

		await expect
			.element(screen.getByRole('img', { name: 'Image 1 of 1, still processing' }))
			.toBeInTheDocument();
	});
});

describe('media that failed', () => {
	it('says it failed rather than rendering a broken image', async () => {
		const failed = aMedia({ id: 'm1', status: 'failed', variants: [] });

		const screen = render(MediaGrid, { items: [failed] });

		await expect.element(screen.getByText('Media unavailable')).toBeInTheDocument();
		expect(document.querySelector('img')).toBeNull();
		expect(tile('m1').dataset.mediaState).toBe('failed');
	});

	it('cannot be opened, because there is nothing to open', async () => {
		const screen = render(MediaGrid, {
			items: [aMedia({ id: 'm1', status: 'failed', variants: [] })]
		});

		expect(screen.getByRole('button').elements()).toHaveLength(0);
	});
});

describe('video', () => {
	const clipItem = aMedia({
		id: 'v1',
		kind: 'video',
		mime: 'video/mp4',
		width: 1280,
		height: 720,
		durationMs: 7400,
		variants: ['original', 'poster', 'video']
	});

	const clip = (variants: MediaVariant[]) =>
		aMedia({
			id: 'v1',
			kind: 'video',
			mime: 'video/mp4',
			width: 1280,
			height: 720,
			durationMs: 7400,
			variants
		});

	it('plays inline from its poster frame, fetching no bytes until asked', async () => {
		render(MediaGrid, { items: [clip(['original', 'poster', 'video'])] });

		const video = document.querySelector('video') as HTMLVideoElement;
		expect(video.getAttribute('poster')).toBe('/media/v1/poster');
		expect(video.getAttribute('src')).toBe('/media/v1/video');
		expect(video.hasAttribute('controls')).toBe(true);
		expect(video.hasAttribute('playsinline')).toBe(true);
		// The poster is the point: a 200MB clip must not download to render a card.
		expect(video.getAttribute('preload')).toBe('none');
	});

	it('plays the original when the source needed no transcode', async () => {
		render(MediaGrid, { items: [clip(['original', 'poster'])] });

		expect(document.querySelector('video')?.getAttribute('src')).toBe('/media/v1/original');
	});

	it('says how long it is', async () => {
		const screen = render(MediaGrid, { items: [clip(['original', 'poster', 'video'])] });

		await expect.element(screen.getByText('0:07')).toBeInTheDocument();
	});

	it('is not swept into the lightbox: it plays where it sits', async () => {
		const screen = render(MediaGrid, { items: [clip(['original', 'poster', 'video'])] });

		// The tile's own accessible name belongs to the video, not to a button that
		// would enlarge it. Asserted by name rather than by counting buttons,
		// because the player contributes its own controls (frame stepping) and a
		// bare count would break every time those change while proving nothing.
		expect(
			screen.getByRole('button', { name: mediaLabel(clipItem, 0, 1) }).elements()
		).toHaveLength(0);
		expect(screen.getByRole('dialog').elements()).toHaveLength(0);
	});

	it('gives the owner frame-by-frame control, which native controls cannot', async () => {
		const screen = render(MediaGrid, { items: [clip(['original', 'poster', 'video'])] });

		await expect
			.element(screen.getByRole('button', { name: 'Back one frame' }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Forward one frame' }))
			.toBeInTheDocument();
	});
});

describe('opening the lightbox from the grid', () => {
	const three = [1, 2, 3].map((n) => aMedia({ id: `m${n}` }));

	it('opens on the image the owner clicked', async () => {
		const screen = render(MediaGrid, { items: three });

		await openTile('m2');

		const dialog = screen.getByRole('dialog', { name: 'Media viewer' });
		await expect.element(dialog).toBeInTheDocument();
		await expect.element(screen.getByText('2 of 3')).toBeInTheDocument();
	});

	it('gives the dialog the focus, so the next key press goes to it', async () => {
		const screen = render(MediaGrid, { items: three });

		await openTile('m1');

		const dialog = screen.getByRole('dialog', { name: 'Media viewer' }).element();
		await expect.poll(() => dialog.contains(document.activeElement)).toBe(true);
	});

	it('walks the images with the arrow keys and closes on Escape', async () => {
		const screen = render(MediaGrid, { items: three });
		await openTile('m1');

		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByText('2 of 3')).toBeInTheDocument();

		await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
		// Wraps: three images are a ring, not a dead end.
		await expect.element(screen.getByText('3 of 3')).toBeInTheDocument();

		await userEvent.keyboard('{Escape}');
		expect(screen.getByRole('dialog').elements()).toHaveLength(0);
	});

	it('hands the focus back to the image that opened it', async () => {
		render(MediaGrid, { items: three });
		await openTile('m2');

		await userEvent.keyboard('{Escape}');

		// Otherwise focus falls back to the document and a keyboard reader is
		// dumped at the top of the page.
		await expect
			.poll(() => document.activeElement?.getAttribute('aria-label'))
			.toBe('Image 2 of 3');
	});

	it('offers no lightbox at all when nothing on the card can be enlarged', async () => {
		render(MediaGrid, { items: [aMedia({ id: 'm1', status: 'pending', variants: [] })] });

		// Nothing to click, so nothing to open: a pending item is not a control.
		expect(document.querySelector('[data-media-tile="m1"] button')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
