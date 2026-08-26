import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The secrets the shared preview server boots with.
 *
 * `src/config.ts` validates the environment at module scope in
 * `src/hooks.server.ts`, so a server with no secrets does not serve a
 * fail-closed login page — it refuses to start, and every test in the suite
 * fails as "webServer was not able to start". Fail-closed is now a *boot*
 * property rather than a login-time one, so the harness has to configure the
 * server it wants to exercise.
 *
 * These are throwaway values that exist only for this process. No test logs in
 * against them: `shell.e2e.ts` needs a password it knows, so it boots its own
 * server on its own port with its own hash.
 */
const previewEnv = {
	// A throwaway data directory, so a preview run never writes a SQLite file or
	// media tree into the working copy — and never into the directory a local
	// `npm start` is using.
	DATA_DIR: previewDataDir(),
	// argon2id over a password nothing in this suite types.
	ADMIN_PASSWORD_HASH:
		'$argon2id$v=19$m=65536,p=4,t=3$TgOZFkx4ph6hCxjplC5GQw$S5Sdievoat/Z0I9LGsHXGye2fz6Roxbp2c/bCfHYCZo',
	SESSION_SECRET: 'preview-session-secret-at-least-32-chars',
	TOKEN_SECRET: 'preview-token-secret-at-least-32-chars!!',
	// adapter-node defaults this to 512K and the app advertises 200 MiB video, a
	// mismatch `assertBodyLimitAllowsUploads` refuses to boot on. `.env.example`
	// sets the same number.
	BODY_SIZE_LIMIT: '209715200'
};

/**
 * A clean data directory for the preview server, at a fixed path.
 *
 * Emptied once per run rather than created afresh: this file is re-evaluated in
 * every worker process, so `mkdtemp` here would leak one directory per worker
 * per run, and only the one the main process computed would ever be served. The
 * emptying matters because the migration runner refuses to open a database whose
 * applied migrations no longer match `MIGRATIONS` — a throwaway directory that
 * survived a schema change would otherwise stop the server booting.
 */
function previewDataDir(): string {
	const dir = join(tmpdir(), 'agent-dashboard-e2e-preview');
	// Playwright sets this in workers and leaves it unset in the main process,
	// which is the one that spawns the server.
	if (process.env.TEST_WORKER_INDEX === undefined) rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

export default defineConfig({
	// Tests live next to the code they cover, as `*.e2e.ts`.
	testDir: 'src',
	testMatch: '**/*.e2e.{ts,js}',
	// The one smoke test in the design (§9) proves the SSE path, so it needs the
	// real Node-adapter server rather than the dev server.
	webServer: {
		command: 'npm run build:all && npm run preview',
		port: 4173,
		env: previewEnv,
		reuseExistingServer: !process.env.CI
	},
	use: { baseURL: 'http://localhost:4173' },
	// CI also writes the HTML report so a failure can be downloaded as an artifact.
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0
});
