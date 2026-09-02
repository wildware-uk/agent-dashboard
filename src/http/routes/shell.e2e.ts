import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The **authenticated** shell, end to end (design §7).
 *
 * `page.e2e.ts` cannot cover this: nothing there knows the shared server's
 * password, so the guard 303s `/` to `/login` and every assertion there lands on
 * the login page. This file therefore boots a *second* server — the same
 * `node build` output, its own port, its own throwaway data directory — with a
 * password hash it knows, logs in for real, and asserts the dashboard.
 *
 * What is real here: the Node-adapter server, the session cookie, the server
 * render, the client store, the stylesheet, and the browser. What is faked is
 * the *server side of the stream*: `page.route` answers `/api/stream` and
 * `/api/snapshot` so a test can decide exactly when an event arrives. Proving
 * that an agent posting over MCP reaches this browser is `src/smoke.e2e.ts`'s
 * job (#18), where nothing is stubbed at all; proving that an event on the
 * stream reaches the DOM with no reload is this file's job, and does not need
 * the MCP surface to do it.
 */

/** A fixed port, so `test.use({ baseURL })` can name it. Not 4173: that is the shared server. */
const PORT = 4179;
const ORIGIN = `http://localhost:${PORT}`;

/** Test-only credentials. The hash is argon2id over the password below. */
const PASSWORD = 'e2e-owner-password';
const PASSWORD_HASH =
	'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo';

let server: ChildProcess | undefined;
let dataDir = '';

test.use({ baseURL: ORIGIN });

test.beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-e2e-'));
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
			// adapter-node caps request bodies at 512K by default, well under the
			// 200 MiB of video this app advertises, and startup refuses that
			// mismatch rather than serving 413s it cannot explain. Without this the
			// server below never comes up.
			BODY_SIZE_LIMIT: '209715200'
		}
	});

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`${ORIGIN}/login`);
			if (response.ok) {
				// Fixed port, so make sure the thing answering is ours: a stray process
				// on 4179 would otherwise turn every assertion below into a mystery.
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
		if (Date.now() > deadline) throw new Error('the authenticated test server never came up');
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
}

type Update = {
	id: string;
	seq: number;
	body: string;
	level?: 'info' | 'success' | 'warn' | 'error';
	title?: string | null;
	/** Who posted it. A ULID in production, which is the point of #20. */
	agentId?: string;
};

const project = {
	id: 'p1',
	seq: 1,
	slug: 'agent-dashboard',
	name: 'Agent Dashboard',
	description: null,
	status: 'active',
	pinned: true,
	createdAt: Date.now(),
	updatedAt: Date.now()
};

function update({ id, seq, body, level = 'info', title = null, agentId = 'claude-code' }: Update) {
	return {
		id,
		seq,
		projectId: 'p1',
		agentId,
		sessionId: null,
		title,
		body,
		level,
		pinned: false,
		createdAt: Date.now(),
		deletedAt: null
	};
}

/**
 * Answer the snapshot endpoints from a mutable list, and the stream from a queue
 * of gated bodies.
 *
 * The snapshot is a function of the current list, so a test changes the list and
 * the *next* refetch sees it — which is exactly how the browser experiences an
 * agent posting something.
 *
 * Two things here are about the *shell as a whole* rather than the timeline, and
 * both would be wrong if this faked only what one store asks for:
 *
 * 1. **`/api/snapshot` and `/api/snapshot/agents` are different documents.** The
 *    right rail reads the second one and derives `online` from `agents`, so
 *    answering it with the timeline document leaves that field `undefined` and
 *    the rail throws on every clock tick — which takes the *timeline's* renders
 *    down with it, because they share a flush.
 * 2. **A frame goes to every open connection.** The real server fans an event
 *    out to all subscribers, and the shell now has two (the timeline store and
 *    the rail's). Handing the frame to whichever connection asked first would
 *    starve the other, so a scripted delivery is offered to each of them.
 */
function fakeServer(page: Page) {
	let items: ReturnType<typeof update>[] = [];
	let seq = 0;
	let agentNames: Record<string, string> = {};
	let live: { agentId: string; name: string }[] = [];
	const gates: { open: Promise<void>; body: string }[] = [];

	const snapshot = (route: Route) => {
		const body = JSON.stringify({
			seq,
			at: new Date().toISOString(),
			projects: [project],
			updates: { items, nextCursor: null, hasMore: false },
			// Every agent this deployment knows, offline and revoked included: this
			// is what lets a card name a poster that presence has never heard of.
			agentNames
		});
		return route.fulfill({ status: 200, contentType: 'application/json', body });
	};

	/**
	 * `GET /api/snapshot/agents`: who is beating right now.
	 *
	 * The heartbeat is stamped at request time, because the browser derives
	 * presence against its own clock — a fixed timestamp would be expired before
	 * the rail ever painted it.
	 */
	/**
	 * The snapshot endpoints this shell reads that these tests do not drive.
	 *
	 * `**\/api/snapshot**` catches every one of them, so a document shaped like the
	 * timeline's would reach the request store and the task store as *their*
	 * answer — and a store handed a payload with its list missing has an undefined
	 * list, which is a crash in whichever component reads it next. The shell reads
	 * the request queue itself now (the sidebar's counts), so that crash is no
	 * longer contained to one region: it takes the page.
	 *
	 * Empty is the honest answer here. A test that wants a request or a task on
	 * screen drives the real server, in `requests.e2e.ts` and `smoke.e2e.ts`.
	 */
	const emptyList = (route: Route, key: 'requests' | 'tasks') => {
		const body = JSON.stringify({ seq, at: new Date().toISOString(), [key]: [] });
		return route.fulfill({ status: 200, contentType: 'application/json', body });
	};

	const agents = (route: Route) => {
		const now = Date.now();
		const body = JSON.stringify({
			seq,
			at: new Date().toISOString(),
			agents: live.map((agent) => ({
				...agent,
				sessionId: `s-${agent.agentId}`,
				startedAt: now,
				lastHeartbeatAt: now,
				sessions: 1,
				host: 'wildware',
				cwd: '/srv/ssd1/app',
				model: 'opus'
			}))
		});
		return route.fulfill({ status: 200, contentType: 'application/json', body });
	};

	return {
		async install() {
			await page.route('**/api/snapshot**', (route) => {
				const path = new URL(route.request().url()).pathname;
				if (path.startsWith('/api/snapshot/agents')) return agents(route);
				if (path.startsWith('/api/snapshot/requests')) return emptyList(route, 'requests');
				if (path.startsWith('/api/snapshot/tasks')) return emptyList(route, 'tasks');
				return snapshot(route);
			});
			await page.route('**/api/stream**', async (route) => {
				// Each connection reads the script from the start, so one scripted
				// event reaches every subscriber exactly as the real bus delivers it.
				const next = gates[0];
				if (!next) {
					// No events scripted: hold the connection open rather than letting
					// `EventSource` reconnect in a loop behind the test.
					await new Promise(() => {});
					return;
				}
				await next.open;
				await route.fulfill({
					status: 200,
					headers: {
						'content-type': 'text/event-stream; charset=utf-8',
						'cache-control': 'no-store'
					},
					body: next.body
				});
			});
		},

		/** The names `GET /api/snapshot` will carry from now on. */
		setAgentNames(next: Record<string, string>) {
			agentNames = next;
		},

		/** Who `GET /api/snapshot/agents` will say is online from now on. */
		setLiveAgents(next: { agentId: string; name: string }[]) {
			live = next;
		},

		/** What `GET /api/snapshot` will say from now on. */
		setUpdates(next: Update[]) {
			items = next.map(update);
			seq = Math.max(seq, ...next.map((item) => item.seq));
		},

		/**
		 * Script one SSE delivery, in the server's own frame format, and hand back
		 * the trigger that releases it.
		 */
		scriptEvent(type: string, payload: Record<string, unknown>, at: number) {
			let release = () => {};
			const open = new Promise<void>((resolve) => (release = resolve));
			gates.push({
				open,
				// `retry` is long so the connection closing after this one frame does
				// not start a reconnect loop mid-test.
				body:
					`retry: 60000\n\n` +
					`id: ${at}\nevent: ${type}\ndata: ${JSON.stringify({ type, seq: at, at: new Date().toISOString(), payload })}\n\n`
			});
			return release;
		}
	};
}

test.describe('the authenticated shell', () => {
	test('logs in and renders the three regions', async ({ page }) => {
		await signIn(page);

		await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible();
		await expect(page.getByLabel('Update timeline')).toBeVisible();
		await expect(page.locator('[data-rail]')).toBeAttached();
		// A fresh deployment: no agent has posted anything yet, and the shell says
		// so rather than looking broken.
		await expect(page.getByText(/Nothing here yet/)).toBeVisible();
	});

	test('renders agent markdown as text, never as markup', async ({ page }) => {
		const server = fakeServer(page);
		await server.install();
		server.setUpdates([
			{
				id: 'u1',
				seq: 1,
				title: 'Deploy',
				body: '# Shipped\n\n<script>window.__pwned = true</script>'
			}
		]);

		await signIn(page);

		await expect(page.getByRole('heading', { name: 'Shipped' })).toBeVisible();
		await expect(page.getByText('<script>window.__pwned = true</script>')).toBeVisible();
		// The proof, in the browser the owner is actually using: no element was
		// created and no script ran (design §8).
		await expect(page.locator('article script')).toHaveCount(0);
		expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
	});

	test('shows an update arriving on the stream, with no reload', async ({ page }) => {
		const server = fakeServer(page);
		await server.install();
		const arrive = server.scriptEvent('update.created', { updateId: 'u9', projectId: 'p1' }, 9);

		await signIn(page);
		await expect(page.getByText(/Nothing here yet/)).toBeVisible();

		// An agent posts. The browser is told an id; it goes and reads the rest.
		server.setUpdates([{ id: 'u9', seq: 9, body: 'just landed', level: 'success' }]);
		arrive();

		await expect(page.getByText('just landed')).toBeVisible();
		await expect(page.locator('article[data-level="success"]')).toBeVisible();
	});

	test('attributes every card to an agent name rather than to a ULID', async ({ page }) => {
		// Real agent ids. Every one of them begins `01` until September 2039, which
		// is why a card showing the id says nothing about who posted it, and why
		// the avatars all read "01" before #20.
		const gone = '01M0X5XHT67FCP294SSA3B2XHV';
		const beating = '01M0X5XHT67FCP294SSAKQ9WFP';
		const nameless = '01M0X5XHT67FCP294SSAZZ7QRS';

		const server = fakeServer(page);
		await server.install();
		server.setUpdates([
			{ id: 'u1', seq: 1, body: 'wrote the docs', agentId: gone },
			{ id: 'u2', seq: 2, body: 'build is green', agentId: beating },
			{ id: 'u3', seq: 3, body: 'who posted this', agentId: nameless }
		]);
		// `docs-writer` is not online and never will be again; its updates are
		// still on the page, which is the case presence alone cannot cover.
		server.setAgentNames({ [gone]: 'docs-writer' });
		server.setLiveAgents([{ agentId: beating, name: 'build-bot' }]);

		await signIn(page);

		const docs = page.locator('article', { hasText: 'wrote the docs' });
		const build = page.locator('article', { hasText: 'build is green' });
		const unknown = page.locator('article', { hasText: 'who posted this' });

		// The offline agent, named from the timeline snapshot.
		await expect(docs).toContainText('docs-writer');
		await expect(docs).not.toContainText(gone);
		// The agent that is beating, named from presence — the same read that a
		// newly registered session provokes, with no reload.
		await expect(build).toContainText('build-bot');
		await expect(build).not.toContainText(beating);
		// Two agents, two badges. Both of these used to read "01".
		await expect(docs.locator('[data-hue]')).toHaveText('DW');
		await expect(build.locator('[data-hue]')).toHaveText('BB');
		// Nobody can name this one, and it still reads as something rather than as
		// 26 characters of ULID.
		await expect(unknown).toContainText('agent-zz7qrs');
		await expect(unknown).not.toContainText(nameless);
	});

	test('offers an "N new" pill instead of moving a scrolled timeline', async ({ page }) => {
		const server = fakeServer(page);
		await server.install();
		const arrive = server.scriptEvent('update.created', { updateId: 'new', projectId: 'p1' }, 99);
		const many = Array.from({ length: 30 }, (_, index) => ({
			id: `u${30 - index}`,
			seq: 30 - index,
			body: `update ${30 - index}`
		}));
		server.setUpdates(many);

		await signIn(page);
		await expect(page.getByText('update 30')).toBeVisible();

		const timeline = page.locator('[data-timeline]');
		await timeline.evaluate((element) => element.scrollTo({ top: 600 }));
		const before = await timeline.evaluate((element) => element.scrollTop);
		expect(before).toBeGreaterThan(0);

		server.setUpdates([{ id: 'new', seq: 99, body: 'just landed' }, ...many]);
		arrive();

		await expect(page.getByRole('button', { name: '1 new update' })).toBeVisible();
		// The viewport did not move, and the card is not above the reader yet.
		expect(await timeline.evaluate((element) => element.scrollTop)).toBe(before);
		await expect(page.getByText('just landed')).toHaveCount(0);

		await page.getByRole('button', { name: '1 new update' }).click();

		await expect(page.getByText('just landed')).toBeVisible();
	});

	test('is usable at 375px, with the sidebar as a drawer', async ({ page }) => {
		const server = fakeServer(page);
		await server.install();
		server.setUpdates([{ id: 'u1', seq: 1, body: 'a phone-sized update' }]);
		await page.setViewportSize({ width: 375, height: 667 });

		await signIn(page);

		// One column: the permanent sidebar and the rail are both out of the way.
		await expect(page.getByRole('navigation', { name: 'Projects' })).toBeHidden();
		await expect(page.locator('[data-rail]')).toBeHidden();
		await expect(page.getByText('a phone-sized update')).toBeVisible();
		// Nothing overflows sideways on a phone — measured against the DEVICE width,
		// not `window.innerWidth`.
		//
		// This assertion used to compare scrollWidth with innerWidth, which cannot
		// fail the way that matters: when content refuses to shrink, the browser
		// widens the layout viewport and zooms out, so both numbers grow together
		// and the difference stays zero. A wide update really did push a 375px phone
		// to a 723px layout viewport while this test stayed green.
		const layout = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth
		}));
		expect(layout.innerWidth).toBe(375);
		expect(layout.scrollWidth).toBeLessThanOrEqual(375);

		await page.getByRole('button', { name: 'Open projects' }).click();

		const drawer = page.getByRole('dialog', { name: 'Projects' });
		await expect(drawer).toBeVisible();
		await expect(drawer.getByRole('link', { name: /Agent Dashboard/ })).toBeVisible();
	});

	test.describe('following the system theme', () => {
		test.use({ colorScheme: 'light' });

		test('renders the shell light when the OS asks for light', async ({ page }) => {
			await signIn(page);

			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			// A real light surface, not dark text on a dark background.
			const surface = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
			expect(surface).not.toBe('rgba(0, 0, 0, 0)');
			expect(await page.evaluate(() => getComputedStyle(document.body).color)).not.toBe(surface);
		});
	});

	test.describe('with a dark OS preference', () => {
		test.use({ colorScheme: 'dark' });

		test('stays dark, with a readable timeline', async ({ page }) => {
			const server = fakeServer(page);
			await server.install();
			server.setUpdates([{ id: 'u1', seq: 1, body: 'dark mode update' }]);

			await signIn(page);

			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
			await expect(page.getByText('dark mode update')).toBeVisible();
			const surface = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
			expect(surface).not.toBe('rgba(0, 0, 0, 0)');
			expect(await page.evaluate(() => getComputedStyle(document.body).color)).not.toBe(surface);
		});
	});
});

/**
 * Mobile Safari's focus zoom (#feedback: "stop the site zooming in on mobile").
 *
 * iOS zooms the page in whenever a focused form control has a font-size under
 * 16px, and every control here is `text-sm` — so tapping the composer shoved
 * the dashboard sideways and the owner had to pinch back out. The fix is a
 * `pointer: coarse` rule in `app.css`, which is why this runs in a touch
 * context: without `hasTouch` the media query does not match and the assertion
 * would pass against desktop CSS while the phone stayed broken.
 */
test.describe('on a touch screen', () => {
	test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

	test('gives every box a font iOS will not zoom in on', async ({ page }) => {
		const server = fakeServer(page);
		await server.install();
		server.setUpdates([{ id: 'u1', seq: 1, body: 'a phone-sized update' }]);

		await signIn(page);

		// Every control, not just the composer: the zoom happens on whichever one
		// is tapped, so one at 14px is enough to bring it back.
		const sizes = await page.evaluate(() =>
			[...document.querySelectorAll('input, select, textarea')].map((element) =>
				Number.parseFloat(getComputedStyle(element).fontSize)
			)
		);

		expect(sizes.length).toBeGreaterThan(0);
		expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
	});

	test('keeps pinch-to-zoom, which is the fix people reach for and should not', async ({
		page
	}) => {
		const server = fakeServer(page);
		await server.install();
		await signIn(page);

		// `maximum-scale=1` and `user-scalable=no` also stop the auto-zoom, by
		// taking zoom away from everyone who needs it to read the screen at all.
		const viewport = await page.evaluate(
			() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
		);

		expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
	});
});
