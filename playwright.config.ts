import { defineConfig } from '@playwright/test';

export default defineConfig({
	// Tests live next to the code they cover, as `*.e2e.ts`.
	testDir: 'src',
	testMatch: '**/*.e2e.{ts,js}',
	// The one smoke test in the design (§9) proves the SSE path, so it needs the
	// real Node-adapter server rather than the dev server.
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: { baseURL: 'http://localhost:4173' },
	// CI also writes the HTML report so a failure can be downloaded as an artifact.
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0
});
