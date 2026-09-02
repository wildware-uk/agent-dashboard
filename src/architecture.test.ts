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
	// The Claude Code channel bridge (design §5). It imports nothing from this
	// tree at all: it runs beside the *agent*, not beside the dashboard, talks to
	// the deployment over HTTP like any other client, and touches no database.
	// An import here would be a module that has to be installed on the agent's
	// machine to read a reply.
	channel: [],
	// The design table lists `domain, mcp, media`. Two edges are added.
	//
	// `web`, because `src/http/routes/` is the SvelteKit route tree and a route
	// has to render the components that live in `src/web/`. The arrow only points
	// this way: `web` importing `http` stays forbidden.
	//
	// `events`, because the SSE route *is* the fan-out to the browser: the
	// architecture diagram in §2 draws `src/events/ ──SSE push──> browser`
	// through this module, and §4 makes `GET /api/stream` the reader of the
	// replay ring buffer. Subscribing to the bus and serialising `AppEvent`s is
	// transport work, not a business rule, so it cannot be laundered through
	// `domain` without inventing a pass-through there. The rule this does not
	// weaken: `http` still may not touch `db`, and may not publish rules of its
	// own — it reads the bus, it does not decide what goes on it.
	http: ['domain', 'mcp', 'media', 'web', 'events'],
	// `web` ships to the browser. Its only data source is the HTTP API.
	web: []
};

const MODULES = Object.keys(MAY_IMPORT);
const SRC = resolve(import.meta.dirname);

/** `$db` -> `db`. `$lib` is an alias for `src/web`, so it maps to `web`. */
function moduleForAlias(specifier: string): string | undefined {
	const match = /^\$(db|events|media|domain|mcp|channel|http|web|lib)(\/|$)/.exec(specifier);
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

/**
 * The browser's event registration, against the server's vocabulary.
 *
 * `src/web/stream.ts` names the event types the leading tab registers on its
 * `EventSource`, and a type missing from that list is a frame **no store can
 * ever receive** — the consumer filter never runs, because the listener was
 * never attached. That failure is silent in exactly the worst way: the feature
 * works in every unit test, and is simply dead in the browser.
 *
 * So the two lists are compared here rather than remembered. This test lives at
 * the root because `web` may import nothing from the tree (the table above), and
 * a root test belongs to no module.
 */
describe('the event vocabulary', () => {
	/**
	 * Events the browser is deliberately not registered for.
	 *
	 * `messages.read` moves an *agent's* unread count (`src/http/stream/agent.ts`).
	 * The owner's dashboard has no unread count of its own, so a frame for it
	 * would be a wake-up with nothing to do.
	 */
	const SERVER_ONLY = new Set(['messages.read']);

	it('registers every event the server can publish', async () => {
		const { EVENT_TYPES } = await import('./web/stream');
		const { EventBus } = await import('./events');

		// The bus is typed by `EventPayloads`, and a type map has no runtime
		// value — so the names are taken from the source of truth that does exist
		// at runtime: the interface's keys as the file declares them.
		const types = readFileSync(resolve(SRC, 'events', 'types.ts'), 'utf8');
		const block = /export interface EventPayloads \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
		const names = [...block.matchAll(/^\t'([a-z.]+)':/gm)].map((match) => match[1]);

		expect(EventBus, 'the bus should still be importable').toBeTypeOf('function');
		expect(names.length, 'no event names were found to check').toBeGreaterThan(5);

		const missing = names.filter(
			(name) => !SERVER_ONLY.has(name) && !(EVENT_TYPES as readonly string[]).includes(name)
		);
		expect(missing, 'these events would never reach a browser store').toEqual([]);
	});

	it('registers nothing the server cannot publish', async () => {
		const { EVENT_TYPES } = await import('./web/stream');
		const types = readFileSync(resolve(SRC, 'events', 'types.ts'), 'utf8');
		const names = new Set([...types.matchAll(/^\t'([a-z.]+)':/gm)].map((match) => match[1]));

		// `resync` is the transport's own frame rather than a bus event, so it is
		// the one name that is legitimately in the browser's list and not the
		// server's vocabulary.
		const unknown = (EVENT_TYPES as readonly string[]).filter(
			(type) => type !== 'resync' && !names.has(type)
		);
		expect(unknown, 'these are registered for and can never arrive').toEqual([]);
	});
});
