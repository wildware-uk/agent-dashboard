// The real stylesheet, so heights are the ones a browser would actually lay out.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import Clamp from './Clamp.svelte';

/**
 * Long content, shortened until somebody asks for the rest (design §7).
 *
 * The owner: "shorten the message content, if its too long." The "if" is the
 * part worth testing: a short card must be untouched, with no control and no
 * fade, or every ordinary update grows a button that does nothing.
 */
function mount(lines: number) {
	return render(Clamp, {
		max: 200,
		noun: 'the whole thing',
		children: createRawSnippet(() => ({
			render: () => `<p>${'a line of text<br>'.repeat(lines)}</p>`
		}))
	});
}

describe('shortening what is too long', () => {
	it('leaves a short card exactly as it was', async () => {
		const screen = mount(2);

		expect(screen.container.querySelector('[data-clamp]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="clamp-toggle"]')).toBeNull();
	});

	it('folds a long one, and offers the rest', async () => {
		const screen = mount(80);

		await expect.element(screen.getByTestId('clamp-toggle')).toBeInTheDocument();
		await expect.poll(() => screen.container.querySelector('[data-clamp]')).not.toBeNull();
	});

	it('shows everything once asked, and can fold it back', async () => {
		const screen = mount(80);

		const toggle = screen.getByTestId('clamp-toggle');
		await expect.element(toggle).toHaveTextContent('Show the whole thing');

		await toggle.click();
		await expect.element(toggle).toHaveTextContent('Show less');
		expect(screen.container.querySelector('[data-clamp]')).toBeNull();

		await toggle.click();
		await expect.element(toggle).toHaveTextContent('Show the whole thing');
	});
});
