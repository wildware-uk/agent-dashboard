import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CHANNEL_NAME } from './stream';

/**
 * The tab's one connection to `GET /api/stream`, in the browser (#19, design §4).
 *
 * This is the file that has to be run in a real browser, because the bug was
 * never visible anywhere else: Chromium allows **six sockets per origin on
 * HTTP/1.1**, an SSE connection holds one for as long as the page is open, and
 * nothing else on the origin can jump that queue. Two connections per tab —
 * one for the timeline store, one for the rail's — meant three tabs and the
 * whole origin stopped answering: no snapshots, no media, no navigation. A unit
 * test cannot see any of that, and HTTP/2 hides it, which is why it survived
 * until somebody followed the README quickstart over plain HTTP.
 *
 * Its own server, on its own port, with a password it knows, for the same
 * reason `shell.e2e.ts` boots one: the shared preview server's password is not
 * known to any test, so every assertion here would otherwise land on the login
 * page. The port is this file's alone so two e2e files can run at once.
 */

const PORT = 4181;
const ORIGIN = `http://localhost:${PORT}`;

/** Test-only credentials. The hash is argon2id over the password below. */
const PASSWORD = 'e2e-owner-password';
const PASSWORD_HASH =
	'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo';

let server: ChildProcess | undefined;
let dataDir = '';

test.use({ baseURL: ORIGIN });

test.beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-stream-'));
	// `build/` is already there: Playwright's `webServer` builds before any test
	// runs (see playwright.config.ts).
	server = spawn('node', ['build'], {
		stdio: 'ignore',
		env: {
			...process.env,
			PORT: String(PORT),
			ORIGIN,
			DATA_DIR: dataDir,
			ADMIN_PASSWORD_HASH: PASSWORD_HASH,
			SESSION_SECRET: 'e2e-session-secret-at-least-32-chars-long',
			TOKEN_SECRET: 'e2e-token-secret-at-least-32-chars-long!',
			PUBLIC_BASE_URL: ORIGIN,
			BODY_SIZE_LIMIT: '209715200'
		}
	});

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`${ORIGIN}/login`);
			if (response.ok) {
				const html = await response.text();
				if (!html.includes('Agent Dashboard')) {
					throw new Error(`something other than this app is listening on ${ORIGIN}`);
				}
				break;
			}
		} catch (cause) {
			if (cause instanceof Error && cause.message.startsWith('something other')) throw cause;
			// Not listening yet.
		}
		if (Date.now() > deadline) throw new Error('the stream test server never came up');
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
});

test.afterAll(() => {
	server?.kill('SIGTERM');
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Log in the way the owner does: the form, the password, the cookie. */
async function signIn(page: Page) {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('Owner password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(ORIGIN + '/');
	await expect(page.getByLabel('Update timeline')).toBeVisible();
}

/** Count every request for the stream, wherever in the context it came from. */
function streamRequests(context: BrowserContext): string[] {
	const urls: string[] = [];
	context.on('request', (request) => {
		if (request.url().includes('/api/stream')) urls.push(request.url());
	});
	return urls;
}

/** Can this tab still get an answer out of the origin? */
async function reachable(page: Page): Promise<{ ok: boolean; ms: number }> {
	return page.evaluate(async () => {
		const started = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 6000);
		try {
			const response = await fetch(`/api/snapshot?limit=1&at=${Math.random()}`, {
				signal: controller.signal
			});
			await response.json();
			return { ok: response.ok, ms: Date.now() - started };
		} catch {
			return { ok: false, ms: Date.now() - started };
		} finally {
			clearTimeout(timer);
		}
	});
}

test.describe('the tab and its one connection', () => {
	test('opens exactly one stream, however many regions read it', async ({ page }) => {
		// Request interception rather than an observer: this is the assertion the
		// whole slice exists for, so it is made against the requests the browser
		// actually issued, with the real server answering them.
		const opened: string[] = [];
		await page.route('**/api/stream**', async (route) => {
			opened.push(route.request().url());
			await route.continue();
		});

		await signIn(page);
		// Both live regions are mounted: the timeline, and the rail that reads
		// presence. Each of them used to open its own connection.
		await expect(page.locator('[data-rail]')).toBeAttached();
		await expect.poll(() => opened.length).toBe(1);

		// And it stays one: nothing reconnects behind the test.
		await page.waitForTimeout(1500);

		expect(opened).toHaveLength(1);
	});

	test('a tab that takes the connection over resumes from the last event seen', async ({
		page
	}) => {
		// The resume cursor goes in the query string because `EventSource` cannot
		// set headers, and this is the path that has to keep working now the
		// connection can outlive the tab that opened it: the browser is the one
		// that hands `Last-Event-ID` to a reconnect it performs itself, and
		// Playwright's interception cannot see that header at all.
		const context = page.context();
		const opened: string[] = [];
		// The frame is held back until both tabs are open, so the second one is
		// listening when the first is told about it — which is the whole of what a
		// follower knows.
		let deliver = () => {};
		const arrival = new Promise<void>((resolve) => (deliver = resolve));
		await context.route('**/api/stream**', async (route) => {
			opened.push(route.request().url());
			if (opened.length > 1) {
				// Hold the second connection open rather than letting it loop.
				await new Promise(() => {});
				return;
			}
			await arrival;
			await route.fulfill({
				status: 200,
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store'
				},
				// One event at seq 9, and a retry long enough that nothing reconnects
				// on its own before the tab holding it is closed.
				body:
					'retry: 60000\n\n' +
					'id: 9\nevent: update.created\n' +
					'data: {"type":"update.created","seq":9,"at":"2026-08-25T10:00:00.000Z","payload":{"updateId":"u9","projectId":"p1"}}\n\n'
			});
		});

		await signIn(page);
		const second = await context.newPage();
		await second.goto('/');
		await expect(second.getByLabel('Update timeline')).toBeVisible();
		await expect.poll(() => opened.length).toBe(1);

		// Listen on the channel the tabs share, so the test waits for the frame to
		// have actually reached the second tab rather than for a length of time.
		await second.evaluate((name) => {
			const window_ = window as unknown as { seen: number[] };
			window_.seen = [];
			new BroadcastChannel(name).addEventListener('message', (event: MessageEvent) => {
				const message = event.data as { kind: string; frame?: { seq: number } };
				if (message.kind === 'frame' && message.frame) window_.seen.push(message.frame.seq);
			});
		}, CHANNEL_NAME);

		deliver();
		await expect
			.poll(() => second.evaluate(() => (window as unknown as { seen: number[] }).seen))
			.toEqual([9]);

		// The tab that held the connection goes away, now the other one has been
		// handed what arrived on it.
		await page.close();

		await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(2);
		// The tab that took over knew what the other one had already been told.
		expect(opened[1]).toContain('last_event_id=9');
	});

	test('gives one frame to the timeline and to the rail alike', async ({ page }) => {
		// Both stores answer an event by refetching their own snapshot (events
		// carry identifiers, not data), so two different endpoints being read is
		// exactly the proof that one frame reached two consumers.
		const read: string[] = [];
		await page.route('**/api/snapshot**', async (route) => {
			read.push(new URL(route.request().url()).pathname);
			await route.continue();
		});
		let served = 0;
		await page.route('**/api/stream**', async (route) => {
			served += 1;
			if (served > 1) {
				await new Promise(() => {});
				return;
			}
			await route.fulfill({
				status: 200,
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store'
				},
				// `resync` is the one frame both stores watch: the server sends it when
				// a reconnect lands outside the ring buffer and the browser has to go
				// and read its state again.
				body:
					'retry: 60000\n\n' +
					'id: 9\nevent: resync\ndata: {"type":"resync","seq":9,"at":"2026-08-25T10:00:00.000Z"}\n\n'
			});
		});

		await signIn(page);

		await expect.poll(() => read.filter((path) => path === '/api/snapshot')).not.toHaveLength(0);
		await expect
			.poll(() => read.filter((path) => path === '/api/snapshot/agents'))
			.not.toHaveLength(0);
	});
});

test.describe('navigating between projects', () => {
	test('neither leaks a connection nor loses the one it has', async ({ page }) => {
		// Navigating to a project rebuilds the shell and both of its stores
		// (`{#key}` in `projects/[slug]/+page.svelte`), which is the moment a
		// ref-counted connection either leaks or is closed under somebody's feet.
		const isStream = (url: string) => url.includes('/api/stream');
		const opened: string[] = [];
		let live = 0;
		page.on('request', (request) => {
			if (!isStream(request.url())) return;
			opened.push(request.url());
			live += 1;
		});
		page.on('requestfinished', (request) => void (isStream(request.url()) && (live -= 1)));
		page.on('requestfailed', (request) => void (isStream(request.url()) && (live -= 1)));

		await signIn(page);
		await expect.poll(() => live).toBe(1);

		const slug = await page.evaluate(async () => {
			const response = await fetch('/api/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ name: 'Connection Test' })
			});
			const body = (await response.json()) as { project: { slug: string } };
			return body.project.slug;
		});
		// The sidebar link, not `goto`: a client-side navigation is the case that
		// rebuilds the stores without reloading the document, so a connection left
		// behind here would be one left behind for the life of the tab.
		await page
			.getByRole('link', { name: /Connection Test/ })
			.first()
			.click();
		await expect(page).toHaveURL(new RegExp(`/projects/${slug}`));
		await expect(page.getByLabel('Update timeline')).toBeVisible();

		// Still exactly one connection open, and no pile of abandoned ones behind
		// it: the shell that unmounted let go of its hold, and the one that replaced
		// it took a new one.
		await expect.poll(() => live, { timeout: 10_000 }).toBe(1);
		expect(opened.length).toBeLessThanOrEqual(2);
	});
});

test.describe('six tabs of the same dashboard', () => {
	test('share one connection, and the origin keeps answering', async ({ page }) => {
		const context = page.context();
		const opened = streamRequests(context);

		await signIn(page);
		const tabs = [page];
		for (let index = 0; index < 5; index += 1) {
			const tab = await context.newPage();
			await tab.goto('/');
			await expect(tab.getByLabel('Update timeline')).toBeVisible();
			tabs.push(tab);
		}
		// Give the last tab time to open a connection if it were going to.
		await page.waitForTimeout(1000);

		// The whole browser holds one socket on this origin, not six.
		expect(opened).toHaveLength(1);

		// Six tabs open, and a snapshot still comes back — this is the request
		// that hung forever at three tabs before the fix.
		const answered = await reachable(tabs[5]);
		expect(answered.ok).toBe(true);
		expect(answered.ms).toBeLessThan(5000);

		// And the origin still navigates, which is the other half of "dead".
		const seventh = await context.newPage();
		await seventh.goto('/', { timeout: 10_000 });
		await expect(seventh.getByLabel('Update timeline')).toBeVisible();
		expect(opened).toHaveLength(1);
	});
});
