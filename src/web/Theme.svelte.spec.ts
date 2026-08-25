import { render } from 'vitest-browser-svelte';
import { beforeEach, expect, it } from 'vitest';
import Theme from './Theme.svelte';

beforeEach(() => {
	localStorage.removeItem('theme');
	document.documentElement.dataset.theme = 'dark';
});

it('starts on whatever app.html already resolved', async () => {
	const screen = render(Theme);

	await expect.element(screen.getByRole('button')).toHaveTextContent('Dark');
});

it('flips the document theme and remembers the choice', async () => {
	const screen = render(Theme);

	await screen.getByRole('button').click();

	expect(document.documentElement.dataset.theme).toBe('light');
	expect(localStorage.getItem('theme')).toBe('light');
	await expect.element(screen.getByRole('button')).toHaveTextContent('Light');
});
