import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Attachments from './Attachments.svelte';
import { Uploads } from './uploads.svelte';
import { fakeActions } from './testing';

/**
 * Attaching images to a message (migration 016).
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

	it('ignores whatever else came with the paste', async () => {
		// A clipboard carries the text that came with the screenshot. Complaining
		// about it would be complaining about the normal case.
		const { acts, uploads } = mount();

		await uploads.add([new File(['hello'], 'note.txt', { type: 'text/plain' })]);

		expect(acts.calls).toEqual([]);
		expect(uploads.ids).toEqual([]);
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

		await expect.element(screen.getByRole('button', { name: 'Add image' })).toBeInTheDocument();
		await expect.element(screen.getByText(/paste, or drop/)).toBeInTheDocument();
	});

	it('renders nothing but the chooser when there is nothing attached', async () => {
		mount();

		expect(document.querySelectorAll('[data-attachments] li')).toHaveLength(0);
	});
});
