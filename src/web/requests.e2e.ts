import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Owner requests, end to end (design §5, §7).
 *
 * This is the only test in the tree where all three halves of the slice are
 * real at once: a **real MCP client** asks over HTTP with a real minted token, a
 * **real browser** answers on the card, and the value the agent receives is
 * the one the human clicked. Everything below the browser is production code —
 * the Node-adapter server, the session cookie, SQLite, the event bus, the SSE
 * stream — because a gate that only works in unit tests is not a gate.
 *
 * The agent side deliberately implements *the loop the tool description tells an
 * agent to implement*: call `request_input`, and while the answer is `pending`,
 * call `await_request` again. `HOLD_S` is two seconds here rather than the
 * default fifty-five, so the pending branch is exercised on every kind that the
 * human is slow to answer instead of only in theory.
 *
 * It boots its own server on its own port with its own throwaway data directory,
 * exactly as `src/http/routes/shell.e2e.ts` does, because it needs a password it
 * knows and a database nothing else is writing to.
 */

/**
 * A port of this file's own.
 *
 * Not 4173 (the shared preview), 4179 (`shell.e2e.ts`) or 4181 (`stream.e2e.ts`):
 * Playwright runs files in parallel workers, and two suites on one port means one
 * of them silently talks to the other's database.
 */
const PORT = 4183;
const ORIGIN = `http://localhost:${PORT}`;

/** Test-only credentials. The hash is argon2id over the password below. */
const PASSWORD = 'e2e-owner-password';
const PASSWORD_HASH =
	'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo';

let server: ChildProcess | undefined;
let dataDir = '';
let token = '';

test.use({ baseURL: ORIGIN });
// Five round trips, each with a two second hold in it, plus a build's worth of
// process startup.
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
	// Short on purpose: the hold is what makes `pending` and the resume loop real
	// rather than a branch nothing takes (design §5).
	HOLD_S: '2',
	BODY_SIZE_LIMIT: '209715200'
});

test.beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-requests-'));

	// The token an agent authenticates with, minted by the operator CLI against
	// this deployment's own database — the same path a self-hoster takes (§10).
	const minted = spawnSync('node', ['build/cli.js', 'mint-token', 'e2e-agent'], {
		env: env(),
		encoding: 'utf8'
	});
	if (minted.status !== 0) throw new Error(`mint-token failed: ${minted.stderr}`);
	// `agent <id>  <name>` first, then the token on its own line, then a warning.
	token = minted.stdout.split('\n')[1].trim();
	if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
		throw new Error(`mint-token printed something unexpected:\n${minted.stdout}`);
	}

	server = spawn('node', ['build'], { stdio: 'ignore', env: env() });

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
		if (Date.now() > deadline) throw new Error('the owner-request test server never came up');
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

/** An agent's MCP client, authenticated the way its config file would be. */
async function agent(): Promise<Client> {
	const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } }
		})
	);
	return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>) {
	const result = (await client.callTool({ name, arguments: args })) as ToolResult;
	expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
	return result.structuredContent!;
}

/**
 * The loop every agent is told to run, run for real.
 *
 * `request_input` parks for `HOLD_S` and then answers `pending`; the contract is
 * that the agent keeps calling `await_request` until it does not. Nothing else
 * in this file would work if that contract were wrong, which is the point.
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

test('all five kinds round-trip: an agent asks, a human answers, the agent gets the value', async ({
	page
}) => {
	await signIn(page);
	const client = await agent();
	const waiting = page.getByTestId('request-section');

	// 1. text — the agent needs a string it cannot invent.
	const text = call(client, 'request_input', {
		kind: 'text',
		question: 'What should the commit message be?',
		detail: 'Two files changed in the parser.',
		placeholder: 'fix: …'
	});
	await expect(waiting).toContainText('What should the commit message be?', { timeout: 20_000 });
	await expect(waiting).toContainText('Two files changed in the parser.', { timeout: 20_000 });
	await page.getByLabel('Your answer').fill('fix: the parser drops trailing commas');
	await page.getByRole('button', { name: 'Send' }).click();

	expect(await keepWaiting(client, await text)).toMatchObject({
		state: 'answered',
		response: { kind: 'text', value: 'fix: the parser drops trailing commas' }
	});

	// 2. confirm — permission, and a boolean back.
	const confirm = call(client, 'request_input', {
		kind: 'confirm',
		question: 'Push to main?'
	});
	await expect(waiting).toContainText('Push to main?', { timeout: 20_000 });
	await page.getByRole('button', { name: 'Approve' }).click();

	expect(await keepWaiting(client, await confirm)).toMatchObject({
		state: 'answered',
		response: { kind: 'confirm', value: true }
	});

	// 3. buttons — one action out of several.
	const buttons = call(client, 'request_input', {
		kind: 'buttons',
		question: 'The build failed. What now?',
		options: ['retry', 'skip', 'abort']
	});
	await expect(waiting).toContainText('The build failed. What now?', { timeout: 20_000 });
	await page.getByRole('button', { name: 'skip', exact: true }).click();

	expect(await keepWaiting(client, await buttons)).toMatchObject({
		state: 'answered',
		response: { kind: 'buttons', value: 'skip' }
	});

	// 4. choice — one option from a list.
	const choice = call(client, 'request_input', {
		kind: 'choice',
		question: 'Which branch should I target?',
		options: ['main', 'next', 'release/1.2']
	});
	await expect(waiting).toContainText('Which branch should I target?', { timeout: 20_000 });
	await page.getByRole('radio', { name: 'release/1.2' }).click();
	await page.getByRole('button', { name: 'Send' }).click();

	expect(await keepWaiting(client, await choice)).toMatchObject({
		state: 'answered',
		response: { kind: 'choice', value: 'release/1.2' }
	});

	// 5. multi_choice — any number of options, bounded.
	const many = call(client, 'request_input', {
		kind: 'multi_choice',
		question: 'Which of these files should I delete?',
		options: ['a.ts', 'b.ts', 'c.ts'],
		min: 1,
		max: 2
	});
	await expect(waiting).toContainText('Which of these files should I delete?', { timeout: 20_000 });
	await page.getByRole('checkbox', { name: 'a.ts' }).click();
	await page.getByRole('checkbox', { name: 'c.ts' }).click();
	await page.getByRole('button', { name: 'Send' }).click();

	expect(await keepWaiting(client, await many)).toMatchObject({
		state: 'answered',
		response: { kind: 'multi_choice', value: ['a.ts', 'c.ts'] }
	});

	// Nothing is left waiting on the owner.
	await expect(waiting).toBeHidden();
	await client.close();
});

test('several blocked agents each get their own card, and none is lost', async ({ page }) => {
	await signIn(page);
	const first = await agent();
	const second = await agent();
	const waiting = page.getByTestId('request-section');

	const one = call(first, 'request_input', { kind: 'confirm', question: 'Deploy the migration?' });
	const two = call(second, 'request_input', {
		kind: 'buttons',
		question: 'Retry the flaky test?',
		options: ['retry', 'give up']
	});

	// Both are answerable where they sit: two cards, each with its own control,
	// rather than one on screen and the rest reduced to chips (design §7).
	await expect(waiting).toContainText('Deploy the migration?', { timeout: 20_000 });
	await expect(waiting).toContainText('Retry the flaky test?', { timeout: 20_000 });
	await expect(page.getByTestId('request-card')).toHaveCount(2, { timeout: 20_000 });
	await expect(waiting.getByTestId('request-count')).toContainText('(2)', { timeout: 20_000 });

	await page.getByRole('button', { name: 'Approve' }).click();
	expect(await keepWaiting(first, await one)).toMatchObject({
		state: 'answered',
		response: { value: true }
	});

	// Answering one takes its card off the feed and leaves the other alone.
	await expect(page.getByTestId('request-card')).toHaveCount(1, { timeout: 20_000 });
	await expect(waiting).toContainText('Retry the flaky test?', { timeout: 20_000 });
	await page.getByRole('button', { name: 'give up' }).click();
	expect(await keepWaiting(second, await two)).toMatchObject({
		state: 'answered',
		response: { kind: 'buttons', value: 'give up' }
	});

	await first.close();
	await second.close();
});

test('a dismissal reaches the agent as cancelled, not as permission', async ({ page }) => {
	await signIn(page);
	const client = await agent();

	const asked = call(client, 'request_input', {
		kind: 'confirm',
		question: 'Force-push over main?'
	});
	await expect(page.getByTestId('request-section')).toContainText('Force-push over main?', {
		timeout: 20_000
	});
	await page.getByRole('button', { name: 'Dismiss' }).click();

	expect(await keepWaiting(client, await asked)).toMatchObject({ state: 'cancelled' });
	await client.close();
});

/**
 * The server is the only thing standing between a hostile browser and an agent
 * that will act on the answer, so the hostile answer is posted at the endpoint
 * rather than typed into the UI.
 */
test('an answer that violates the request is refused by the server, not by the page', async ({
	page
}) => {
	await signIn(page);
	const client = await agent();

	const asked = call(client, 'request_input', {
		kind: 'choice',
		question: 'Which branch should I release from?',
		options: ['main', 'next']
	});
	await expect(page.getByTestId('request-section')).toContainText('Which branch should I release', {
		timeout: 20_000
	});
	const pending = await asked;
	const id = pending.request_id as string;

	// Straight at the endpoint, with the owner's own session cookie.
	const refused = await page.evaluate(
		async ([requestId, value]) => {
			const response = await fetch(`/api/requests/${requestId}/answer`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value })
			});
			return { status: response.status, body: await response.json() };
		},
		[id, 'rm -rf /'] as const
	);

	expect(refused.status).toBe(400);
	expect(refused.body.error).toBe('invalid_argument');

	// And the agent is still waiting, not holding a value nobody offered.
	const resumed = await call(client, 'await_request', { request_id: id });
	expect(resumed.state).toBe('pending');

	await page.getByRole('radio', { name: 'next' }).click();
	await page.getByRole('button', { name: 'Send' }).click();
	expect(await keepWaiting(client, resumed)).toMatchObject({
		response: { kind: 'choice', value: 'next' }
	});
	await client.close();
});

/**
 * The durability claim, proved the only way it can be: a client that never made
 * the request resumes it.
 */
test('a fresh client resumes a wait it never started', async ({ page }) => {
	await signIn(page);
	const crashed = await agent();

	const asked = await call(crashed, 'request_input', {
		kind: 'text',
		question: 'What should I name the release?'
	});
	expect(asked.state).toBe('pending');
	// The agent dies mid-wait, connection and all.
	await crashed.close();

	const restarted = await agent();
	const resumed = keepWaiting(
		restarted,
		await call(restarted, 'await_request', {
			request_id: asked.request_id
		})
	);

	await expect(page.getByTestId('request-section')).toContainText(
		'What should I name the release?',
		{ timeout: 20_000 }
	);
	await page.getByLabel('Your answer').fill('Ada');
	await page.getByRole('button', { name: 'Send' }).click();

	expect(await resumed).toMatchObject({
		state: 'answered',
		response: { kind: 'text', value: 'Ada' }
	});
	await restarted.close();
});
