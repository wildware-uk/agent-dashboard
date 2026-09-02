/**
 * The Claude Code channel bridge (`src/channel/`) → `build/channel.js`.
 *
 * A separate entry point from the server and the CLI for one reason: this
 * process runs wherever the *agent* runs, which is not necessarily the
 * dashboard host. It talks to the deployment over HTTP and touches no database,
 * so bundling it with the CLI would drag `better-sqlite3`, `argon2` and `sharp`
 * onto a machine that needs none of them.
 */
import { bridgeBuild } from './vite.bridge';

export default bridgeBuild({
	entry: 'bin.ts',
	name: 'channel',
	outDir: 'build',
	extension: 'js',
	bundleSdk: false
});
