import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as domain from './index';

/**
 * `$domain` is the whole surface `$mcp` and `$http` get to see. A re-export
 * dropped in a refactor should fail here, not in an adapter's suite.
 */
describe('the $domain surface', () => {
	it('exposes the project and update functions this slice owns', () => {
		for (const name of [
			'context',
			'createProject',
			'listProjects',
			'updateProject',
			'findProject',
			'resolveProject',
			'postUpdate',
			'listUpdates',
			'deleteUpdate',
			'slugify',
			'isSlug'
		] as const) {
			expect(domain[name], name).toBeTypeOf('function');
		}
	});

	it('exposes the error vocabulary an adapter maps onto its own status codes', () => {
		expect(domain.DomainError).toBeTypeOf('function');
		expect(domain.isDomainError(domain.notFound('gone'))).toBe(true);
	});

	it('keeps the test harness out of the production entry point', () => {
		expect(Object.keys(domain)).not.toContain('harness');
	});

	it('imports no HTTP or MCP type anywhere in the module', () => {
		const dir = join(import.meta.dirname);
		const offenders = readdirSync(dir)
			.filter((file) => file.endsWith('.ts'))
			.filter((file) =>
				/from\s*['"](\$http|\$mcp|@modelcontextprotocol|@sveltejs)/.test(
					readFileSync(join(dir, file), 'utf8')
				)
			);

		expect(offenders).toEqual([]);
	});
});
