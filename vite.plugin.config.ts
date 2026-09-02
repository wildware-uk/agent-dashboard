/**
 * The plugin's copy of the channel bridge → `plugins/agent-dashboard/bin/channel.mjs`.
 *
 * Committed, and with the SDK inlined: a plugin is installed by cloning a
 * directory, so there is no `npm install` and no `node_modules` beside it.
 */
import { bridgeBuild } from './vite.bridge';

export default bridgeBuild({
	entry: 'bin.ts',
	name: 'channel',
	outDir: 'plugins/agent-dashboard/bin',
	extension: 'mjs',
	bundleSdk: true
});
