/**
 * Build of the operator CLI (`src/cli/`) to `build/cli.js`.
 *
 * Separate from the SvelteKit build because it is a second entry point into the
 * same code, not a route: `mint-token` and `hash-password` have to run before
 * the server is usable at all (design §10).
 *
 * Everything is bundled except the three modules with native bindings, so the
 * result runs against the production-only `node_modules` the Docker image
 * installs. `hashPassword` lives in `$http/auth`, which pulls in `@sveltejs/kit`
 * — a devDependency that is not there at runtime — so leaving dependencies
 * external would produce a CLI that works in the repo and dies in the image.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);

/** Native bindings: they cannot be bundled, and are production dependencies. */
const NATIVE = ['better-sqlite3', 'argon2', 'sharp'];

export default defineConfig({
	resolve: {
		alias: {
			$config: src('config.ts'),
			$db: src('db'),
			$domain: src('domain'),
			$events: src('events'),
			$media: src('media'),
			$mcp: src('mcp'),
			$http: src('http'),
			$web: src('web'),
			$lib: src('web')
		}
	},
	ssr: { noExternal: true, external: NATIVE },
	build: {
		ssr: true,
		target: 'node22',
		outDir: 'build',
		// The SvelteKit build wrote the server into the same directory.
		emptyOutDir: false,
		minify: false,
		rollupOptions: {
			input: src('cli/bin.ts'),
			external: NATIVE,
			output: {
				format: 'esm',
				entryFileNames: 'cli.js',
				banner: '#!/usr/bin/env node'
			}
		}
	}
});
