import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Attachments from './Attachments.svelte';
import { Uploads } from './uploads.svelte';
import { fakeActions } from './testing';

/**
 * Attaching files to a message (migration 016, migration 026).
 *
 * Three ways in, because they are three different habits: the chooser, a paste,
 * and a drop. Paste and drop are events on the box that owns the textarea, so
 * they are asserted in the boxes; this covers the queue and what it renders.
 */
const png = (name = 'shot.png') =>
	new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

function mount() {
	const acts = fakeActions();
	const uploads = new Uploads(acts.actions);
	return { acts, uploads, screen: render(Attachments, { uploads }) };
}

describe('the queue', () => {
	it('uploads a chosen file and holds its id for the message', async () => {
		const { acts, uploads } = mount();

		await uploads.add([png()]);

		expect(acts.calls).toEqual([{ name: 'uploadMedia', args: ['shot.png'] }]);
		expect(uploads.ids).toEqual(['m-shot.png']);
	});

	it('sends whatever it is handed, not only pictures', async () => {
		// Migration 026: the owner asked to be able to send agents any file. What
		// used to be filtered out here is now the feature.
		const { acts, uploads } = mount();

		await uploads.add([new File(['hello'], 'note.txt', { type: 'text/plain' })]);

		expect(acts.calls).toEqual([{ name: 'uploadMedia', args: ['note.txt'] }]);
		expect(uploads.ids).toEqual(['m-note.txt']);
	});

	it('shows a file with no preview by its name', async () => {
		const { uploads, screen } = mount();

		await uploads.add([new File(['id,name'], 'rows.csv', { type: 'text/csv' })]);

		await expect.element(screen.getByText('rows.csv')).toBeInTheDocument();
	});

	it('keeps the good ones when one upload fails, and says what went wrong', async () => {
		const { acts, uploads } = mount();
		await uploads.add([png('first.png')]);
		acts.fail(new Error('too large'));

		await uploads.add([png('second.png')]);

		expect(uploads.ids).toEqual(['m-first.png']);
		expect(uploads.error).toBe('too large');
	});

	it('takes one back off before it is sent', async () => {
		const { uploads } = mount();
		await uploads.add([png()]);

		uploads.remove(uploads.items[0].key);

		expect(uploads.ids).toEqual([]);
	});

	it('forgets everything once the message has posted', async () => {
		const { uploads } = mount();
		await uploads.add([png()]);

		uploads.clear();

		expect(uploads.items).toEqual([]);
	});
});

describe('what it renders', () => {
	it('shows a thumbnail per attachment, with a way to remove it', async () => {
		const { uploads, screen } = mount();

		await uploads.add([png('screenshot.png')]);

		await expect
			.element(screen.getByRole('button', { name: 'Remove screenshot.png' }))
			.toBeInTheDocument();
		expect(document.querySelectorAll('[data-attachments] li')).toHaveLength(1);
	});

	it('offers the chooser, and says the other two ways in', async () => {
		const { screen } = mount();

		await expect.element(screen.getByRole('button', { name: 'Add file' })).toBeInTheDocument();
		await expect.element(screen.getByText(/paste, or drop/)).toBeInTheDocument();
	});

	it('renders nothing but the chooser when there is nothing attached', async () => {
		mount();

		expect(document.querySelectorAll('[data-attachments] li')).toHaveLength(0);
	});
});

/**
 * Watching a file go up (the owner: "I'd also like to see upload progress on files").
 *
 * A 400MB file over a slow link used to be a dimmed thumbnail and no news for a
 * minute, which is indistinguishable from a hung upload. The bar is the
 * difference.
 */
describe('upload progress', () => {
	/** An upload that stays in flight until the test says otherwise. */
	function held() {
		let report: ((sent: number, total: number | null) => void) | undefined;
		let land: (() => void) | undefined;
		const uploads = new Uploads({
			uploadMedia: (file, onProgress) =>
				new Promise((resolve) => {
					report = onProgress;
					land = () =>
						resolve({
							id: `m-${file.name}`,
							kind: 'image',
							mime: 'image/png',
							status: 'ready',
							bytes: file.size,
							width: null,
							height: null,
							durationMs: null,
							filename: file.name,
							posterUrl: null,
							originalUrl: `/media/m-${file.name}/original`,
							thumbUrl: null,
							displayUrl: null
						} as never);
				})
		});
		return {
			uploads,
			screen: render(Attachments, { uploads }),
			report: (sent: number, total: number | null) => report?.(sent, total),
			land: () => land?.()
		};
	}

	const big = () => new File([new Uint8Array(100)], 'big.png', { type: 'image/png' });

	it('shows a bar that moves as the bytes leave', async () => {
		const box = held();
		const going = box.uploads.add([big()]);

		await expect
			.element(box.screen.getByRole('progressbar', { name: 'Uploading big.png' }))
			.toHaveAttribute('aria-valuenow', '0');

		box.report(42, 100);
		await expect
			.element(box.screen.getByRole('progressbar', { name: 'Uploading big.png' }))
			.toHaveAttribute('aria-valuenow', '42');

		box.land();
		await going;

		// Gone once it has landed: a finished bar is a bar that says nothing.
		expect(document.querySelectorAll('[data-upload-progress]')).toHaveLength(0);
	});

	it('falls back on the file size when the browser sends no total', async () => {
		const box = held();
		const going = box.uploads.add([big()]);

		box.report(50, null);
		await expect
			.element(box.screen.getByRole('progressbar', { name: 'Uploading big.png' }))
			.toHaveAttribute('aria-valuenow', '50');

		box.land();
		await going;
	});

	it('sweeps rather than sits at zero when nothing can be measured', async () => {
		const box = held();
		// A zero-length file has no denominator anywhere: not from the event, not
		// from `file.size`.
		const going = box.uploads.add([
			new File([], 'empty.bin', { type: 'application/octet-stream' })
		]);

		const bar = box.screen.getByRole('progressbar', { name: 'Uploading empty.bin' });
		await expect.element(bar).toBeInTheDocument();
		// No value at all, rather than a bar pinned at zero: "going" is still true
		// even when "how far" is not known.
		expect(bar.element().getAttribute('aria-valuenow')).toBe(null);
		expect(bar.element().className).toContain('thinking-bar');

		box.land();
		await going.catch(() => {});
	});

	it('never goes past the end, whatever the browser reports', async () => {
		const box = held();
		const going = box.uploads.add([big()]);

		box.report(999, 100);
		await expect
			.element(box.screen.getByRole('progressbar', { name: 'Uploading big.png' }))
			.toHaveAttribute('aria-valuenow', '100');

		box.land();
		await going;
	});
});
