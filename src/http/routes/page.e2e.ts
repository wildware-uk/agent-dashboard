import { expect, test } from '@playwright/test';

// Scaffold smoke test: the Node-adapter build boots and the theme is settled
// before first paint — dark unless the OS asks for light.
//
// Read the target honestly. Nothing here carries a session cookie, so the guard
// 303s `/` to `/login`, and every assertion below lands on the login page —
// which renders the same <h1> and mounts the same <Theme />. The authenticated
// dashboard shell is covered by `shell.e2e.ts`, which boots its own server with
// a known password hash and logs in for real; an update posted over MCP reaching
// the browser is #18.

test.describe('dark-first with system preference', () => {
	test('sends an unauthenticated visitor to the login page', async ({ request }) => {
		// Pins what the tests below are actually exercising, so this file cannot
		// quietly start claiming coverage of a page it never reaches.
		const response = await request.get('/', { maxRedirects: 0 });

		expect(response.status()).toBe(303);
		expect(response.headers()['location']).toContain('/login');
	});

	test('serves the shell', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { name: 'Agent Dashboard' })).toBeVisible();
	});

	test('ships dark in the HTML, so there is no light flash', async ({ request }) => {
		// Before any script runs. `prefers-color-scheme: light` matches even when
		// the OS has expressed no preference, so dark-first has to be the document's
		// authored state rather than something the media query can be asked for.
		const html = await (await request.get('/')).text();

		expect(html).toContain('data-theme="dark"');
	});

	test.describe('with a light OS preference', () => {
		test.use({ colorScheme: 'light' });

		test('follows the OS into light', async ({ page }) => {
			await page.goto('/');

			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		});
	});

	test.describe('with a dark OS preference', () => {
		test.use({ colorScheme: 'dark' });

		test('stays dark', async ({ page }) => {
			await page.goto('/');

			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		});
	});

	test('remembers an explicit choice over the OS preference', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: /Switch to/ }).click();
		const chosen = await page.locator('html').getAttribute('data-theme');

		await page.reload();

		await expect(page.locator('html')).toHaveAttribute('data-theme', chosen!);
	});
});
