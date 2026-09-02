/**
 * Entry point for the channel bridge (`build/channel.js`).
 *
 * Claude Code spawns this over stdio from an MCP config entry; it is never run
 * by hand except to check a token. Everything is in `./bridge.ts` so the logic
 * is testable without a process.
 */
import { main } from './bridge';

await main();
