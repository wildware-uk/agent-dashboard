/**
 * Build of the channel bridge as the **plugin's** copy: `plugins/agent-dashboard/bin/channel.mjs`.
 *
 * Same source as `vite.channel.config.ts`, one difference that matters: this
 * bundle inlines `@modelcontextprotocol/sdk` instead of leaving it external.
 *
 * A plugin is installed by Claude Code cloning a directory. There is no
 * `npm install` step and no `node_modules` beside it, so a bare `import` of the
 * SDK would resolve to nothing on the user's machine and the channel would fail
 * to spawn with a module-not-found — the one error a user cannot act on. The
 * server build keeps the SDK external because it ships with its own
 * `node_modules`; the plugin cannot, so it carries the SDK inside the file.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
	ssr: { noExternal: true },
	build: {
		ssr: true,
		target: 'node22',
		outDir: 'plugins/agent-dashboard/bin',
		emptyOutDir: false,
		minify: false,
		rollupOptions: {
			input: resolve(import.meta.dirname, 'src/channel/bin.ts'),
			output: {
				format: 'esm',
				entryFileNames: 'channel.mjs',
				banner: '#!/usr/bin/env node'
			}
		}
	}
});
