import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The module table from the design (§2), as an executable rule.
 *
 * "Adapters never touch the database, and the domain never imports an adapter
 * type." Reviews forget that; `npm test` will not.
 */
const MAY_IMPORT: Record<string, readonly string[]> = {
	db: [],
	events: [],
	media: ['db', 'events'],
	domain: ['db', 'events', 'media'],
	mcp: ['domain'],
	// The design table lists `domain, mcp, media`. `web` is added because
	// `src/http/routes/` is the SvelteKit route tree and a route has to render
	// the components that live in `src/web/`. The arrow only points this way:
	// `web` importing `http` stays forbidden.
	http: ['domain', 'mcp', 'media', 'web'],
	// `web` ships to the browser. Its only data source is the HTTP API.
	web: []
};

const MODULES = Object.keys(MAY_IMPORT);
const SRC = resolve(import.meta.dirname);

/** `$db` -> `db`. `$lib` is an alias for `src/web`, so it maps to `web`. */
function moduleForAlias(specifier: string): string | undefined {
	const match = /^\$(db|events|media|domain|mcp|http|web|lib)(\/|$)/.exec(specifier);
	if (!match) return undefined;
	return match[1] === 'lib' ? 'web' : match[1];
}

/** Which module a path inside `src/` belongs to, if any. */
function moduleForPath(absolutePath: string): string | undefined {
	const rel = relative(SRC, absolutePath).split(/[/\\]/);
	return MODULES.includes(rel[0]) ? rel[0] : undefined;
}

/** Every module-level import specifier in a `.ts` / `.js` / `.svelte` source. */
export function importSpecifiers(source: string): string[] {
	const patterns = [
		/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
		/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
	];
	const found = new Set<string>();
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) found.add(match[1]);
	}
	return [...found];
}

/**
 * The module a specifier resolves to, or `undefined` when it is not a
 * cross-module import at all (a package, a node builtin, a SvelteKit `$app`
 * import, `$config`, or a file inside the importer's own module).
 */
export function resolveTarget(fromFile: string, specifier: string): string | undefined {
	if (specifier.startsWith('.')) {
		return moduleForPath(resolve(fromFile, '..', specifier));
	}
	return moduleForAlias(specifier);
}

type Violation = { file: string; specifier: string; from: string; to: string };

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|js|svelte)$/.test(entry) && !/\.(test|spec)\.(ts|js)$/.test(entry))
			out.push(full);
	}
	return out;
}

function violations(): Violation[] {
	const found: Violation[] = [];
	for (const module of MODULES) {
		for (const file of sourceFiles(join(SRC, module))) {
			const source = readFileSync(file, 'utf8');
			for (const specifier of importSpecifiers(source)) {
				const to = resolveTarget(file, specifier);
				if (!to || to === module || MAY_IMPORT[module].includes(to)) continue;
				found.push({
					file: posix.join(...relative(SRC, file).split(/[/\\]/)),
					specifier,
					from: module,
					to
				});
			}
		}
	}
	return found;
}

describe('module boundaries', () => {
	it('has a directory for every module in the design table', () => {
		for (const module of MODULES) {
			expect(statSync(join(SRC, module)).isDirectory(), `src/${module} missing`).toBe(true);
		}
	});

	it('documents each module with a README naming its job and its dependencies', () => {
		for (const module of MODULES) {
			const readme = readFileSync(join(SRC, module, 'README.md'), 'utf8');
			expect(readme, `src/${module}/README.md`).toMatch(/One job:/);
			expect(readme, `src/${module}/README.md`).toMatch(/May import:/);
		}
	});

	it('never imports across a boundary the design does not allow', () => {
		expect(violations()).toEqual([]);
	});
});

describe('the boundary checker itself', () => {
	it('reads every import form', () => {
		const source = [
			`import a from '$db';`,
			`import '$events/side-effect';`,
			`export { b } from './local';`,
			`const c = await import('$domain');`,
			`const d = require('$mcp');`
		].join('\n');

		expect(importSpecifiers(source).sort()).toEqual([
			'$db',
			'$domain',
			'$events/side-effect',
			'$mcp',
			'./local'
		]);
	});

	it('maps aliases and escaping relative paths onto modules', () => {
		const file = join(SRC, 'mcp', 'tools', 'post-update.ts');

		expect(resolveTarget(file, '$db')).toBe('db');
		expect(resolveTarget(file, '$lib/stores')).toBe('web');
		expect(resolveTarget(file, '../../db/projects')).toBe('db');
		expect(resolveTarget(file, './sibling')).toBe('mcp');
		expect(resolveTarget(file, '$config')).toBeUndefined();
		expect(resolveTarget(file, 'zod')).toBeUndefined();
		expect(resolveTarget(file, 'node:crypto')).toBeUndefined();
		expect(resolveTarget(file, '$app/environment')).toBeUndefined();
	});
});
