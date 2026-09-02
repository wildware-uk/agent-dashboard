/**
 * The monitor (`src/channel/monitor-bin.ts`) → `build/monitor.js`.
 *
 * The fallback for sessions where channels are off, which is most of them: a
 * monitor needs no launch flag, and Claude Code turns every line it writes to
 * stdout into a notification. Same bridge, different mouth.
 */
import { bridgeBuild } from './vite.bridge';

export default bridgeBuild({
	entry: 'monitor-bin.ts',
	name: 'monitor',
	outDir: 'build',
	extension: 'js',
	bundleSdk: false
});
