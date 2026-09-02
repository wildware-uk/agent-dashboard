import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Share links, end to end (design §7, §8).
 *
 * The claim being tested is the one that matters and cannot be tested any
 * smaller: **a browser with no session, no cookie and no credentials of any kind
 * can read a shared card, and only that card.** So the visitor here is a second
 * browser context with its own cookie jar, which never logs in and never sees
 * the password.
 *
 * Nothing is stubbed. An agent posts over MCP, the owner shares from the real
 * timeline, the link is read by a stranger, and revoking it takes the page away.
 */
/**
 * A port of this file's own.
 *
 * Not 4173 (the shared preview), 4179 (`shell.e2e.ts`), 4181 (`stream.e2e.ts`),
 * 4183 (`requests.e2e.ts`) or 4185 (`smoke.e2e.ts`): Playwright runs files in
 * parallel workers, and two suites on one port means one of them silently talks
 * to the other's database.
 */
const PORT = 4187;
const ORIGIN = `http://localhost:${PORT}`;

const PASSWORD = 'e2e-owner-password';
const PASSWORD_HASH =
	'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo';

let server: ChildProcess | undefined;
let dataDir = '';
let token = '';

test.use({ baseURL: ORIGIN });
test.describe.configure({ timeout: 120_000 });

const env = () => ({
	...process.env,
	PORT: String(PORT),
	ORIGIN,
	DATA_DIR: dataDir,
	ADMIN_PASSWORD_HASH: PASSWORD_HASH,
	SESSION_SECRET: 'e2e-session-secret-at-least-32-chars-long',
	TOKEN_SECRET: 'e2e-token-secret-at-least-32-chars-long!',
	PUBLIC_BASE_URL: ORIGIN,
	BODY_SIZE_LIMIT: '209715200'
});

test.beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-share-'));

	const minted = spawnSync('node', ['build/cli.js', 'mint-token', 'e2e-agent'], {
		env: env(),
		encoding: 'utf8'
	});
	if (minted.status !== 0) throw new Error(`mint-token failed: ${minted.stderr}`);
	token = minted.stdout.split('\n')[1].trim();

	server = spawn('node', ['build'], { stdio: 'ignore', env: env() });

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`${ORIGIN}/login`);
			if (response.ok) break;
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) throw new Error('the share test server never came up');
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
});

test.afterAll(() => {
	server?.kill('SIGTERM');
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(page: Page) {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('Owner password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(ORIGIN + '/');
}

/** An agent posting the card that will be shared. */
async function post(body: string, title: string) {
	const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } }
		})
	);
	await client.callTool({ name: 'create_project', arguments: { name: 'Share Demo' } });
	await client.callTool({
		name: 'post_update',
		arguments: { project: 'share-demo', body, title, level: 'success' }
	});
	await client.close();
}

/** A browser that has never met this deployment: its own cookie jar, no session. */
async function stranger(browser: Browser): Promise<Page> {
	const context = await browser.newContext();
	return context.newPage();
}

test('a stranger with the link reads the card, and nothing else', async ({ page, browser }) => {
	await post('The release went out at 14:02.', 'Released 1.4');
	await signIn(page);

	// The owner shares from the card itself.
	await expect(page.getByText('Released 1.4')).toBeVisible({ timeout: 20_000 });
	await page.getByTestId('share-update').click();
	const url = await page.getByRole('textbox', { name: 'Public link to this update' }).inputValue();
	expect(url).toMatch(new RegExp(`^${ORIGIN}/s/[A-Za-z0-9_-]{43}$`));

	const visitor = await stranger(browser);
	await visitor.goto(url);

	// The card is there, in full.
	await expect(visitor.getByTestId('shared-card')).toContainText('Released 1.4');
	await expect(visitor.getByTestId('shared-card')).toContainText('The release went out at 14:02.');
	await expect(visitor.getByTestId('shared-card')).toContainText('e2e-agent');

	// And the dashboard is not: the same browser, one URL up, is asked to log in.
	await visitor.goto('/');
	await expect(visitor).toHaveURL(/\/login/);
	await visitor.close();
});

test('revoking the link takes the page away from whoever has it', async ({ page, browser }) => {
	await post('Second card, for revoking.', 'Revoke me');
	await signIn(page);

	await expect(page.getByText('Revoke me')).toBeVisible({ timeout: 20_000 });
	const card = page.locator('[data-update-id]', { hasText: 'Revoke me' });
	await card.getByTestId('share-update').click();
	const url = await card.getByRole('textbox', { name: 'Public link to this update' }).inputValue();

	const visitor = await stranger(browser);
	await visitor.goto(url);
	await expect(visitor.getByTestId('shared-card')).toBeVisible();

	await card.getByRole('button', { name: 'Stop sharing' }).click();
	// The owner's own timeline stops calling it public, over the stream.
	await expect(card.getByTestId('share-state')).toBeHidden();

	await visitor.goto(url);
	await expect(visitor.getByTestId('shared-card')).toBeHidden();
	await visitor.close();
});

test('the link unfurls: title, opening text and the address it points at', async ({ page }) => {
	await post('Deployed at 14:02, no rollbacks. See the run for detail.', 'Unfurl me');
	await signIn(page);

	await expect(page.getByText('Unfurl me')).toBeVisible({ timeout: 20_000 });
	const card = page.locator('[data-update-id]', { hasText: 'Unfurl me' });
	await card.getByTestId('share-update').click();
	const url = await card.getByRole('textbox', { name: 'Public link to this update' }).inputValue();

	// Fetched the way a chat app unfurls it: no browser, no session, no cookies.
	const html = await (await fetch(url)).text();

	/** The `content` of one meta tag, whichever way the renderer closed it. */
	const meta = (name: string) =>
		html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)"`))?.[1];

	expect(meta('og:title')).toBe('Unfurl me');
	expect(meta('og:description')).toBe('Deployed at 14:02, no rollbacks. See the run for detail.');
	expect(meta('og:url')).toBe(url);
	// No picture on this card, so the small card rather than a big empty box.
	expect(meta('twitter:card')).toBe('summary');
	expect(meta('og:image')).toBeUndefined();
});

test('media under a share is reachable without a session, and scoped to the card', async ({
	page
}) => {
	await post('A card whose media addresses are public.', 'Media scope');
	await signIn(page);

	await expect(page.getByText('Media scope')).toBeVisible({ timeout: 20_000 });
	const card = page.locator('[data-update-id]', { hasText: 'Media scope' });
	await card.getByTestId('share-update').click();
	const url = await card.getByRole('textbox', { name: 'Public link to this update' }).inputValue();

	// A media id this share does not cover. The answer must be 404 — not 401, and
	// not a redirect to the login form, either of which would tell a stranger
	// there is something there and how to go looking for it.
	const response = await fetch(`${url}/media/01M0X5XHT67FCP294SSA3B2XHV/thumb-640`, {
		redirect: 'manual'
	});

	expect(response.status).toBe(404);
});

test('a made-up link is a 404, not a login page and not a hint', async ({ browser }) => {
	const visitor = await stranger(browser);

	const response = await visitor.goto(`${ORIGIN}/s/${'a'.repeat(43)}`);

	expect(response?.status()).toBe(404);
	// Not redirected to /login: a share URL that bounced to a sign-in form would
	// tell a stranger there is something here worth signing in for.
	expect(visitor.url()).toContain('/s/');
	await visitor.close();
});
