import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import MediaSounds from './MediaSounds.svelte';
import { aMedia } from './testing';

/**
 * Sound on a card, played where it sits (migration 038).
 *
 * The owner: "allow agents and users to attach a number of sound files, that can
 * be played directly in the dashboard."
 */
const aSound = (overrides = {}) =>
	aMedia({
		id: 's1',
		kind: 'audio',
		mime: 'audio/mpeg',
		width: null,
		height: null,
		durationMs: 92_000,
		variants: ['original'],
		...overrides
	});

describe('the sounds on a card', () => {
	it('renders a player pointed at the sound itself', async () => {
		render(MediaSounds, { items: [aSound()] });

		const player = document.querySelector('audio');
		expect(player?.getAttribute('src')).toBe('/media/s1/original');
		expect(player?.hasAttribute('controls')).toBe(true);
		// Metadata only: three voice notes on one card must not pull three files.
		expect(player?.getAttribute('preload')).toBe('metadata');
	});

	it('says how long it is before anything is fetched', async () => {
		render(MediaSounds, { items: [aSound()] });

		expect(document.querySelector('[data-media-sound="s1"]')?.textContent).toContain('1:32');
	});

	it('plays one at a time, so two recordings cannot talk over each other', async () => {
		render(MediaSounds, { items: [aSound(), aSound({ id: 's2' })] });

		const [first, second] = [...document.querySelectorAll('audio')];
		// The element cannot really play in a test runner, so the pause is what is
		// checked: the handler is what stops the other one.
		let paused = false;
		first.pause = () => {
			paused = true;
		};
		second.dispatchEvent(new Event('play'));

		expect(paused).toBe(true);
	});

	it('shows a sound still being stored rather than hiding it', async () => {
		render(MediaSounds, { items: [aSound({ status: 'pending', variants: [] })] });

		expect(document.querySelector('audio')).toBeNull();
		expect(document.querySelector('[data-media-sound="s1"]')?.textContent).toContain('Processing');
	});

	it('says so when one could not be stored', async () => {
		render(MediaSounds, { items: [aSound({ status: 'failed', variants: [] })] });

		expect(document.querySelector('[data-media-sound="s1"]')?.textContent).toContain(
			'could not be stored'
		);
	});

	it('renders nothing at all when a card has no sound on it', async () => {
		render(MediaSounds, { items: [] });

		expect(document.querySelector('[data-media-sounds]')).toBeNull();
	});
});
