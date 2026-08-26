import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import VideoPlayer from './VideoPlayer.svelte';

/**
 * A player of a given CSS width, so the container queries can be exercised at the
 * sizes that actually occur: full card width, a tile in a media grid, and the
 * narrow column on a phone.
 */
function playerAt(width: number) {
	const screen = render(VideoPlayer, {
		src: '/media/x/original',
		poster: '/media/x/poster',
		label: 'A clip'
	});

	// `.player` is absolutely positioned, so its size comes from the nearest
	// positioned ancestor — which on a card is the tile. Give it one of the width
	// being tested so the container queries have something real to answer to.
	const controller = document.querySelector('media-controller') as HTMLElement;
	const host = controller.parentElement as HTMLElement;
	host.style.position = 'relative';
	host.style.width = `${width}px`;
	host.style.height = `${Math.round(width * 0.5625)}px`;

	const find = (selector: string) => host.querySelector(selector) as HTMLElement;
	return { screen, host, controller, find };
}

/**
 * Wait until media-chrome has actually upgraded and laid out.
 *
 * Measuring before this settles reports positions that then move on their own,
 * which would make the hover test fail for a reason that has nothing to do with
 * hover.
 */
async function settled() {
	await Promise.all(
		['media-controller', 'media-control-bar', 'media-fullscreen-button', 'media-volume-range'].map(
			(tag) => customElements.whenDefined(tag)
		)
	);
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await new Promise((resolve) => setTimeout(resolve, 120));
}

describe('the control bar at card width', () => {
	it('does not move the fullscreen button when the pointer arrives', async () => {
		// The volume slider used to expand from zero on hover, which pushed the
		// playback-rate and fullscreen buttons right — so aiming at fullscreen moved
		// it out from under the pointer before the click landed. Nothing in this bar
		// may change width in response to hover.
		const { find } = playerAt(640);
		await settled();

		const fullscreen = find('media-fullscreen-button');
		const before = fullscreen.getBoundingClientRect().x;

		find('media-control-bar').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		find('media-mute-button').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		await settled();

		expect(fullscreen.getBoundingClientRect().x).toBe(before);
	});

	it('keeps every control at a width that can hold them', async () => {
		const { host, find } = playerAt(640);
		await settled();

		for (const tag of [
			'media-play-button',
			'media-time-display',
			'media-time-range',
			'media-mute-button',
			'media-volume-range',
			'media-playback-rate-button',
			'media-fullscreen-button'
		]) {
			const el = find(tag);
			expect(getComputedStyle(el).display, tag).not.toBe('none');
		}
		expect(host.querySelectorAll('button.step')).toHaveLength(2);
	});
});

describe('the control bar when the player is small', () => {
	it('drops the power tools but never play, position or fullscreen', async () => {
		// A tile inside a media grid is a few hundred pixels wide. Everything cannot
		// fit, and what must survive is the ability to play, to see where you are,
		// and to make it bigger.
		const { find } = playerAt(300);
		await settled();

		for (const tag of ['media-play-button', 'media-time-range', 'media-fullscreen-button']) {
			expect(getComputedStyle(find(tag)).display, tag).not.toBe('none');
		}
		for (const tag of ['media-playback-rate-button', 'media-volume-range']) {
			expect(getComputedStyle(find(tag)).display, tag).toBe('none');
		}
		expect(getComputedStyle(find('button.step')).display).toBe('none');
	});

	it('still shows play and fullscreen at its very narrowest', async () => {
		const { find } = playerAt(220);
		await settled();

		expect(getComputedStyle(find('media-play-button')).display).not.toBe('none');
		expect(getComputedStyle(find('media-fullscreen-button')).display).not.toBe('none');
		expect(getComputedStyle(find('media-time-display')).display).toBe('none');
	});
});

describe('double click', () => {
	it('asks for fullscreen on the whole player, not the bare video', async () => {
		// Fullscreening the <video> hands back the browser's own chrome, which is
		// exactly what this player replaces. Fullscreen itself needs a user gesture
		// the test runner cannot fake, so what is asserted is the request target.
		const { host } = playerAt(640);
		await settled();

		const controller = host.querySelector('media-controller')! as HTMLElement;
		let requestedOn: Element | null = null;
		controller.requestFullscreen = function () {
			requestedOn = this as unknown as Element;
			return Promise.resolve();
		};

		controller.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settled();

		expect(requestedOn).toBe(controller);
	});
});
