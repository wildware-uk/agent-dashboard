/**
 * The executable. Built to `build/cli.js` by `vite.cli.config.ts`.
 *
 * The only file in `src/cli/` that touches `process`: everything the commands
 * need is passed to `run` as arguments, which is what lets the tests drive the
 * real command table without spawning anything.
 */
import { run } from './index';

/** Read stdin to end, for `hash-password --stdin`. */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

const code = await run(process.argv.slice(2), {
	env: process.env,
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
	readStdin
});

// Explicit rather than letting the loop drain: the database handle and the
// argon2 thread pool would otherwise hold the process open after the answer has
// already been printed.
process.exit(code);
