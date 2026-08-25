import { expect, test } from '@playwright/test';

// The guard, against the real Node-adapter build. This runs with no
// `ADMIN_PASSWORD_HASH` in the environment — as CI does — which is exactly the
// case that must fail closed: no session can be minted, so every browser route
// still bounces to a login page that says the deployment is not configured.
// Logging in for real is covered by the unit tests around `$http/auth`, which do
// not need a server.

test.describe('the session guard', () => {
	test('sends an unauthenticated visitor to the login page', async ({ page }) => {
		await page.goto('/projects/acme');

		await expect(page).toHaveURL(/\/login\?redirectTo=%2Fprojects%2Facme$/);
		await expect(page.getByLabel('Owner password')).toBeVisible();
	});

	test('asks for one password and nothing else: there is one owner', async ({ page }) => {
		await page.goto('/login');

		await expect(page.locator('input[name="password"]')).toHaveAttribute('type', 'password');
		await expect(page.locator('input[type="text"], input[type="email"]')).toHaveCount(0);
	});

	test('leaves /mcp to its bearer token, never redirecting it to login', async ({ request }) => {
		// The MCP mount arrives with its own slice; whether it 404s or answers, the
		// one thing it must never do is bounce an agent to an HTML login page.
		const response = await request.post('/mcp', {
			headers: { authorization: 'Bearer not-a-real-token' },
			data: {},
			maxRedirects: 0,
			failOnStatusCode: false
		});

		expect(response.status()).not.toBe(303);
		expect(response.headers()['location']).toBeUndefined();
	});
});
