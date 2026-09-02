/**
 * The plugin's copy of the monitor → `plugins/agent-dashboard/bin/monitor.mjs`.
 *
 * Committed and SDK-inlined for the same reason as the channel's copy, and it
 * is the half that works without a launch flag — which makes it the one most
 * installs will actually run.
 */
import { bridgeBuild } from './vite.bridge';

export default bridgeBuild({
	entry: 'monitor-bin.ts',
	name: 'monitor',
	outDir: 'plugins/agent-dashboard/bin',
	extension: 'mjs',
	bundleSdk: true
});
