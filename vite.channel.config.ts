/**
 * Build of the Claude Code channel bridge (`src/channel/`) to `build/channel.js`.
 *
 * A third entry point, separate from the CLI for one reason: this process runs
 * wherever the *agent* runs, which is not necessarily the dashboard host. It
 * talks to the dashboard over HTTP and touches no database, so bundling it with
 * the CLI would drag `better-sqlite3`, `argon2` and `sharp` onto a machine that
 * needs none of them.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
	ssr: { noExternal: true, external: ['@modelcontextprotocol/sdk'] },
	build: {
		ssr: true,
		target: 'node22',
		outDir: 'build',
		// The SvelteKit and CLI builds wrote into the same directory.
		emptyOutDir: false,
		minify: false,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'src/channel/bin.ts'),
			external: [/^@modelcontextprotocol\/sdk/],
			output: {
				format: 'esm',
				entryFileNames: 'channel.js',
				banner: '#!/usr/bin/env node'
			}
		}
	}
});
