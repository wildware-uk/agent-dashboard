import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// The framework's own directories are pointed at the modules from the
			// design's module table (docs/.../design.md §2) so the boundaries in
			// `src/architecture.test.ts` describe the whole tree.
			files: {
				routes: 'src/http/routes',
				lib: 'src/web'
			},
			alias: {
				$db: 'src/db',
				$domain: 'src/domain',
				$events: 'src/events',
				$media: 'src/media',
				$mcp: 'src/mcp',
				$http: 'src/http',
				$web: 'src/web',
				$config: 'src/config.ts'
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					// Svelte component tests. Needs a real browser, so it is not part
					// of `npm test`; run it with `npm run test:component`.
					name: 'component',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					// Node unit tests: db, events, media, domain, mcp. This is the
					// default suite and what CI runs.
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		],
		coverage: {
			provider: 'v8',
			reportsDirectory: 'coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/**/*.d.ts']
		}
	}
});
