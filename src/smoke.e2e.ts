import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';

/**
 * The smoke test (design §9, issue #18) — the whole product, nothing faked.
 *
 * This is the one file in the tree where **every** layer is the real one at the
 * same time: a real `node build` server, a real SQLite file, a real bearer token
 * minted by the operator CLI, a real MCP client speaking Streamable HTTP, the
 * real media pipeline shelling out to `sharp`, the real `GET /api/stream`, and a
 * real browser that logged in through the form.
 *
 * Nothing here calls `page.route`, and that is the point rather than an
 * accident. `src/http/routes/shell.e2e.ts` stubs `/api/stream` and
 * `/api/snapshot` so it can decide exactly when a frame arrives — a good way to
 * test the *store*, and no evidence at all that an agent posting over MCP
 * reaches a browser, because in that file no server ever pushed anything. The
 * headline criterion of #12 ("an update posted over MCP appears in an open
 * browser with no reload") is asserted here and nowhere else, so a stub in this
 * file would leave it asserted nowhere.
 *
 * The "no reload" half is load-bearing and is proved twice over, because it is
 * the claim most easily faked by accident:
 *
 * 1. Every navigation request the browser makes for the dashboard document is
 *    counted, and must still be **one** after the update has appeared. A reload
 *    would be a second one.
 * 2. A value is stamped on `window` after login and read back at the end. A
 *    document that reloaded would have lost it.
 *
 * There are no fixed sleeps: every wait is `expect`/`expect.poll` on a real
 * condition — a locator, a tool result, a counter.
 */

/**
 * A port of this file's own.
 *
 * Not 4173 (the shared preview), 4179 (`shell.e2e.ts`), 4181 (`stream.e2e.ts`)
 * or 4183 (`requests.e2e.ts`): Playwright runs files in parallel workers, and
 * two suites on one port means one of them silently talks to the other's
 * database. 8010 belongs to the reference deployment (design §12) and is never
 * to be bound by a test.
 */
const PORT = 4185;
const ORIGIN = `http://localhost:${PORT}`;

/** Test-only credentials. The hash is argon2id over the password below. */
const PASSWORD = 'e2e-owner-password';
const PASSWORD_HASH =
	'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo';

let server: ChildProcess | undefined;
let dataDir = '';
let token = '';

test.use({ baseURL: ORIGIN });
// An upload, a derivative, and a request whose hold has to expire at least once.
test.describe.configure({ timeout: 120_000 });

const env = () => ({
	...process.env,
	PORT: String(PORT),
	ORIGIN,
	DATA_DIR: dataDir,
	ADMIN_PASSWORD_HASH: PASSWORD_HASH,
	SESSION_SECRET: 'e2e-session-secret-at-least-32-chars-long',
	TOKEN_SECRET: 'e2e-token-secret-at-least-32-chars-long!',
	// The upload URL `create_upload` hands the agent is built from this, so it
	// has to be the address the agent can actually reach (design §6, §12).
	PUBLIC_BASE_URL: ORIGIN,
	// Short on purpose: the owner-request scenario below needs the `pending`
	// branch and the `await_request` resume loop to be real rather than a branch
	// nothing takes (design §5).
	HOLD_S: '2',
	// adapter-node caps bodies at 512K by default and this app advertises 200 MiB
	// of video; startup refuses that mismatch rather than serving 413s it cannot
	// explain, so without this the server never comes up.
	BODY_SIZE_LIMIT: '209715200'
});

test.beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-smoke-'));

	// The token the agent authenticates with, minted by the operator CLI against
	// this deployment's own database — the same path a self-hoster takes (§10),
	// and the reason nothing in this file needs a fixture user.
	const minted = spawnSync('node', ['build/cli.js', 'mint-token', 'smoke-agent'], {
		env: env(),
		encoding: 'utf8'
	});
	if (minted.status !== 0) throw new Error(`mint-token failed: ${minted.stderr}`);
	// `agent <id>  <name>` first, then the token on its own line, then a warning.
	token = minted.stdout.split('\n')[1].trim();
	if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
		throw new Error(`mint-token printed something unexpected:\n${minted.stdout}`);
	}

	// `build/` is already there: Playwright's `webServer` builds before any test
	// runs (see playwright.config.ts).
	server = spawn('node', ['build'], { stdio: 'ignore', env: env() });

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`${ORIGIN}/login`);
			if (response.ok) {
				// Fixed port, so make sure the thing answering is ours: a stray process
				// on 4185 would otherwise turn every assertion below into a mystery.
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
		if (Date.now() > deadline) throw new Error('the smoke test server never came up');
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

/**
 * Count the times the browser fetches the dashboard *document*.
 *
 * A live update must not cost one. This counts navigation requests rather than
 * `framenavigated`, because it is a fresh document — a reload — that would make
 * a re-render look like a push, and a same-document client navigation is not
 * that.
 *
 * Requests that were themselves redirected away do not count, which is what
 * makes "one" the right number: the owner's first visit is a `GET /` that the
 * guard bounces to `/login`, and that bounce is not a load of the dashboard.
 * Only the `GET /` the login form's 303 lands on actually served the page.
 */
function documentLoads(page: Page): () => number {
	const asked: Request[] = [];
	page.on('request', (request) => {
		if (!request.isNavigationRequest() || request.resourceType() !== 'document') return;
		if (new URL(request.url()).pathname !== '/') return;
		asked.push(request);
	});
	return () => asked.filter((request) => request.redirectedTo() === null).length;
}

/** An agent's MCP client, authenticated the way its config file would be. */
async function agent(): Promise<Client> {
	const client = new Client({ name: 'smoke-agent', version: '1.0.0' });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } }
		})
	);
	return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

/** Call a tool and insist it worked; the structured content is where the ids are. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
	const result = (await client.callTool({ name, arguments: args })) as ToolResult;
	expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
	return result.structuredContent!;
}

/**
 * The loop the `request_input` description tells an agent to implement, run for
 * real: park, and while the answer is `pending`, call `await_request` again.
 */
async function keepWaiting(client: Client, first: Record<string, unknown>) {
	let result = first;
	const deadline = Date.now() + 60_000;
	while (result.state === 'pending') {
		if (Date.now() > deadline) throw new Error('the request was never answered');
		result = await call(client, 'await_request', { request_id: result.request_id });
	}
	return result;
}

/**
 * A real screenshot-shaped png, generated rather than committed.
 *
 * Big enough that the 640w thumbnail is a genuine reduction, so a `ready` tile
 * is evidence the pipeline ran rather than evidence it copied the original.
 */
async function screenshotBytes(): Promise<Buffer> {
	return sharp({
		create: { width: 1200, height: 800, channels: 3, background: '#1d4ed8' }
	})
		.png()
		.toBuffer();
}

/**
 * The three steps `create_upload` documents: reserve, PUT the raw bytes, then
 * hand the id to `post_update`.
 */
async function uploadImage(client: Client, filename: string): Promise<string> {
	const bytes = await screenshotBytes();
	const grant = await call(client, 'create_upload', {
		filename,
		mime: 'image/png',
		bytes: bytes.byteLength
	});

	// An absolute URL built from PUBLIC_BASE_URL, used exactly as given — an
	// agent runs on another machine, so this is the one thing it cannot invent.
	const put = await fetch(grant.upload_url as string, {
		method: 'PUT',
		// `fetch` sends no Content-Type for a buffer body, and a PUT without one
		// has its body discarded before it reaches the server.
		headers: { 'content-type': 'image/png' },
		body: new Uint8Array(bytes)
	});
	expect(put.status, await put.text().catch(() => '')).toBe(201);

	return grant.media_id as string;
}

test('an update with an image, posted over MCP, reaches an open browser with no reload', async ({
	page
}) => {
	const loads = documentLoads(page);
	const client = await agent();

	// A project to post into, created over MCP like everything else here.
	const created = await call(client, 'create_project', { name: 'Smoke Test' });
	const slug = (created.project as { slug: string }).slug;

	// The owner is looking at an empty dashboard, and leaves the tab open.
	await signIn(page);
	await expect(page.getByText(/Nothing here yet/)).toBeVisible();
	expect(loads()).toBe(1);
	// A value only this document has. A reload would take it with it.
	await page.evaluate(() => {
		(window as unknown as { __smokeDocument?: string }).__smokeDocument = 'the-first-one';
	});

	// The agent uploads a screenshot and posts an update carrying it. Nothing
	// touches the browser: the only path from here to that tab is the event bus
	// and `GET /api/stream`.
	const mediaId = await uploadImage(client, 'login-error.png');
	const posted = await call(client, 'post_update', {
		project: slug,
		title: 'Parser fixed',
		body: 'The trailing-comma bug is **gone**. Screenshot attached.',
		level: 'success',
		media_ids: [mediaId]
	});
	const updateId = (posted.update as { id: string }).id;

	// It appeared. The card, its level, its markdown rendered as markdown.
	const card = page.locator(`article[data-update-id="${updateId}"]`);
	// A generous ceiling rather than the 5s default. The design's target is one
	// second (§1), but this assertion is here to catch "the SSE path is broken",
	// and a cold CI runner under a parallel suite is not that — a latency budget
	// that fails on a busy machine would only teach people to rerun the build.
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toHaveAttribute('data-level', 'success');
	await expect(card.getByText('gone')).toBeVisible();
	await expect(page.getByText(/Nothing here yet/)).toBeHidden();

	// And so did the image. The tile is reserved at the stored dimensions while
	// the pipeline runs, then swaps to the thumbnail when `media.ready` arrives —
	// which is a second event on the same stream, delivered to the same document.
	const tile = card.locator(`[data-media-tile="${mediaId}"]`);
	await expect(tile).toBeVisible();
	// Derivation is queued rather than inline (`src/media/pipeline.ts`), so this
	// is a second event on the same stream and it waits on a `sharp` resize that
	// a loaded runner may be slow to get to.
	await expect(tile).toHaveAttribute('data-media-state', 'ready', { timeout: 20_000 });
	const thumb = tile.locator('img');
	await expect(thumb).toHaveAttribute('src', new RegExp(`/media/${mediaId}/thumb-`));
	// Bytes really came back for it: a `ready` row whose file 404s would render
	// as a broken image and still satisfy every assertion above.
	await expect
		.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 20_000 })
		.toBeGreaterThan(0);

	// The proof that none of that was a reload wearing a live update's clothes.
	expect(loads()).toBe(1);
	expect(
		await page.evaluate(() => (window as unknown as { __smokeDocument?: string }).__smokeDocument)
	).toBe('the-first-one');

	await client.close();
});

test('an agent blocks on its owner, and the answer it clicked comes back to the tool call', async ({
	page
}) => {
	const loads = documentLoads(page);
	await signIn(page);
	const client = await agent();
	const waiting = page.getByTestId('request-section');

	// A confirm: permission, and a boolean back. The card sits at the top of the
	// feed, above the pinned section, because the agent is stopped until it is
	// answered (§7).
	const confirm = call(client, 'request_input', {
		kind: 'confirm',
		question: 'Push the migration to main?',
		detail: 'It drops the legacy column.'
	});
	await expect(waiting).toContainText('Push the migration to main?', { timeout: 20_000 });
	await expect(waiting).toContainText('It drops the legacy column.');
	await page.getByRole('button', { name: 'Approve' }).click();

	expect(await keepWaiting(client, await confirm)).toMatchObject({
		state: 'answered',
		response: { kind: 'confirm', value: true }
	});

	// A choice: the same round trip, but carrying a real payload rather than a
	// boolean, so the typed answer is proved and not just the yes/no case.
	const choice = call(client, 'request_input', {
		kind: 'choice',
		question: 'Which branch should I release from?',
		options: ['main', 'next', 'release/1.2']
	});
	await expect(waiting).toContainText('Which branch should I release from?', { timeout: 20_000 });
	await page.getByRole('radio', { name: 'release/1.2' }).click();
	await page.getByRole('button', { name: 'Send' }).click();

	expect(await keepWaiting(client, await choice)).toMatchObject({
		state: 'answered',
		response: { kind: 'choice', value: 'release/1.2' }
	});

	// Nothing is left waiting on the owner, and none of it cost a page load: the
	// card arrived and left over the same stream the timeline reads.
	await expect(waiting).toBeHidden();
	expect(loads()).toBe(1);

	await client.close();
});
