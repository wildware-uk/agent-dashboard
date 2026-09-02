/**
 * How the two bridge processes are built: the channel, and the monitor.
 *
 * Four builds share one shape — the same source tree, two entry points, two
 * destinations — so the shape lives here and each config is the four values that
 * differ. One build per entry rather than one build with two inputs, which is
 * not a style preference: two inputs make Rollup hoist the shared code into a
 * hash-named chunk beside them, and the plugin's copy is **committed**, so every
 * rebuild would churn a new file into the diff and leave the last one behind
 * for ever (`emptyOutDir` is off, because three builds write into one folder).
 */
import { defineConfig, type UserConfig } from 'vite';
import { resolve } from 'node:path';

export type BridgeBuild = {
	/** The entry file under `src/channel/`. */
	entry: 'bin.ts' | 'monitor-bin.ts';
	/** What the built file is called, without its extension. */
	name: 'channel' | 'monitor';
	outDir: string;
	extension: 'js' | 'mjs';
	/**
	 * Whether `@modelcontextprotocol/sdk` is inlined.
	 *
	 * The server build leaves it external because the image installs it. A plugin
	 * is cloned with no `node_modules` beside it, so its copy carries the SDK
	 * inside the file or fails to spawn with a module-not-found the user cannot
	 * act on.
	 */
	bundleSdk: boolean;
};

export function bridgeBuild(build: BridgeBuild): UserConfig {
	const root = resolve(import.meta.dirname);

	return defineConfig({
		ssr: build.bundleSdk
			? { noExternal: true }
			: { noExternal: true, external: ['@modelcontextprotocol/sdk'] },
		build: {
			ssr: true,
			target: 'node22',
			outDir: build.outDir,
			// The SvelteKit, CLI and bridge builds all write into `build/`.
			emptyOutDir: false,
			minify: false,
			rollupOptions: {
				input: resolve(root, 'src/channel', build.entry),
				...(build.bundleSdk ? {} : { external: [/^@modelcontextprotocol\/sdk/] }),
				output: {
					format: 'esm',
					entryFileNames: `${build.name}.${build.extension}`,
					// One file, always: an entry that pulled a chunk in beside it would
					// be two files to ship and one of them named by a hash.
					inlineDynamicImports: true,
					banner: '#!/usr/bin/env node'
				}
			}
		}
	});
}
