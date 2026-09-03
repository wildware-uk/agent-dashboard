import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mcp from './index';

/**
 * `$mcp` is the whole surface `$http` mounts. A re-export dropped in a refactor
 * should fail here, not in a route.
 */
describe('the $mcp surface', () => {
	it('exposes what the route and its tests need', () => {
		for (const name of [
			'createMcpHandler',
			'createMcpServer',
			'authenticateMcpRequest',
			'readBearerToken',
			'createTokenRateLimiter',
			'registerTools'
		] as const) {
			expect(mcp[name], name).toBeTypeOf('function');
		}
		expect(mcp.TOOL_NAMES).toEqual([
			'create_project',
			'list_projects',
			'set_project_theme',
			'post_update',
			'edit_update',
			'create_upload',
			'attach_media',
			'register_session',
			'heartbeat',
			'end_session',
			'list_tasks',
			'create_task',
			'claim_task',
			'complete_task',
			'get_messages',
			'post_message',
			'delete_message',
			'react',
			'acknowledge',
			'request_input',
			'await_request'
		]);
	});

	it('keeps the test harness out of the production entry point', () => {
		expect(Object.keys(mcp)).not.toContain('mcpHarness');
	});
});

/**
 * Every shipping `.ts` under `src/mcp/`.
 *
 * Tests are excluded deliberately: a test may read a row back through a
 * repository to prove a write really landed. The rule is about what the request
 * path can reach.
 */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return sources(full);
		return entry.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry) ? [full] : [];
	});
}

describe('no handler in src/mcp touches the database', () => {
	it('imports neither the repositories nor the bus, in any file it ships', () => {
		const files = sources(import.meta.dirname);
		expect(files.length).toBeGreaterThan(5);

		// The SQLite driver itself is not named here on purpose: `src/db/` already
		// owns a test that no file outside it imports the driver, and spelling the
		// package name in this file would make this file its own counter-example.
		const offenders = files.filter((file) =>
			/from\s*['"](\$db|\$events)/.test(readFileSync(file, 'utf8'))
		);

		expect(offenders).toEqual([]);
	});
});
