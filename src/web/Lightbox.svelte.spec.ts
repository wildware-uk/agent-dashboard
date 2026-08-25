import { userEvent } from '@vitest/browser/context';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Lightbox from './Lightbox.svelte';
import { aMedia } from './testing';

/**
 * The lightbox on its own (design §7).
 *
 * Everything here is keyboard behaviour, which is the half of a modal that gets
 * skipped: a dialog that cannot be left by keyboard, or that lets Tab wander
 * behind it into a timeline the reader cannot see, is not usable at all.
 */
const three = [1, 2, 3].map((n) => aMedia({ id: `m${n}` }));

function open(overrides: { index?: number; onclose?: () => void } = {}) {
	const onclose = overrides.onclose ?? vi.fn();
	const screen = render(Lightbox, { items: three, index: overrides.index ?? 0, onclose });
	return { screen, onclose };
}

describe('what it shows', () => {
	it('shows the item it was opened on, full size', async () => {
		const { screen } = open({ index: 1 });

		const img = document.querySelector('[role="dialog"] img') as HTMLImageElement;
		// The 1600w webp, not the original: a phone screenshot is a 2.4MB png and
		// nothing on screen can show more than the large thumbnail has.
		expect(img.getAttribute('src')).toBe('/media/m2/thumb-1600');
		await expect.element(screen.getByText('2 of 3')).toBeInTheDocument();
	});

	it('offers the original for anyone who wants the real file', async () => {
		open({ index: 0 });

		const link = document.querySelector('[role="dialog"] a') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe('/media/m1/original');
	});

	it('is a modal dialog, so a screen reader ignores the page behind it', async () => {
		const { screen } = open();

		const dialog = screen.getByRole('dialog', { name: 'Media viewer' });
		await expect.element(dialog).toHaveAttribute('aria-modal', 'true');
	});
});

describe('the keyboard', () => {
	it('moves forward and back, wrapping in both directions', async () => {
		const { screen } = open();

		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(screen.getByText('3 of 3')).toBeInTheDocument();

		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByText('1 of 3')).toBeInTheDocument();
	});

	it('jumps to the ends with Home and End', async () => {
		const { screen } = open({ index: 1 });

		await userEvent.keyboard('{End}');
		await expect.element(screen.getByText('3 of 3')).toBeInTheDocument();

		await userEvent.keyboard('{Home}');
		await expect.element(screen.getByText('1 of 3')).toBeInTheDocument();
	});

	it('closes on Escape', async () => {
		const { onclose } = open();

		await userEvent.keyboard('{Escape}');

		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('keeps Tab inside itself, forwards and backwards', async () => {
		const { screen } = open();
		const dialog = screen.getByRole('dialog').element();

		// Round the ring twice, which is more stops than the dialog has: focus
		// must never land outside it.
		for (let press = 0; press < 8; press += 1) {
			await userEvent.keyboard('{Tab}');
			expect(dialog.contains(document.activeElement)).toBe(true);
		}

		for (let press = 0; press < 8; press += 1) {
			await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
	});
});

describe('the controls', () => {
	it('closes on the close button', async () => {
		const { onclose } = open();

		(document.querySelector('[role="dialog"] button:last-of-type') as HTMLElement).click();

		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('closes when the owner clicks the backdrop', async () => {
		// Clicked through the DOM: with no stylesheet loaded the backdrop is not
		// where it will be in a real page (see `MediaGrid.svelte.spec.ts`).
		const { onclose } = open();

		(document.querySelector('[aria-label="Dismiss media viewer"]') as HTMLElement).click();

		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('steps with the next and previous buttons', async () => {
		const { screen } = open();

		await screen.getByRole('button', { name: 'Next image' }).click();

		await expect.element(screen.getByText('2 of 3')).toBeInTheDocument();
	});

	it('offers no stepping at all for a single image', async () => {
		const screen = render(Lightbox, { items: [aMedia()], index: 0, onclose: vi.fn() });

		expect(screen.getByRole('button', { name: 'Next image' }).elements()).toHaveLength(0);
		await expect.element(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
	});
});
