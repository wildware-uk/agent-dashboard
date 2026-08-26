import { describe, expect, it } from 'vitest';
import { appRoutePrefixes, isAppRequest, stubAppRoutes } from '../vite-test-plugins.ts';

/**
 * Issue #21: a passing run must not print stack traces after its summary.
 *
 * The traces came from the component project. Its Vite server carries the whole
 * SvelteKit plugin, so a request a component makes for real — the SSE stream,
 * a thumbnail, a project link — fell through to SvelteKit's *dev handler*,
 * which cannot initialise a server inside the browser runner and threw a
 * `TypeError: Cannot read properties of undefined (reading 'wrapDynamicImport')`
 * once per request, straight to the terminal, after the run had finished.
 *
 * A component test has no server behind it, so the honest answer to those
 * requests is "nothing" rather than a half-built one. `stubAppRoutes` answers
 * them 204 ahead of SvelteKit's handler — 204 because some of them are
 * navigations, and a browser told 204 stays on the page the test is running on.
 * It is installed only while Vitest is the one running Vite.
 */
describe('the app routes a component test must not reach the dev handler with', () => {
	it('reads them off the route tree, so a new route needs no second list', () => {
		const prefixes = appRoutePrefixes();

		expect(prefixes).toEqual(expect.arrayContaining(['/api', '/media', '/projects', '/login']));
	});

	it('claims the app’s own URLs, whole segment at a time', () => {
		const prefixes = ['/api', '/media', '/projects'];

		expect(isAppRequest('/api/stream', prefixes)).toBe(true);
		expect(isAppRequest('/api/snapshot/agents?since=4', prefixes)).toBe(true);
		expect(isAppRequest('/media/m3/thumb-1600', prefixes)).toBe(true);
		expect(isAppRequest('/projects/agent-dashboard', prefixes)).toBe(true);
		expect(isAppRequest('/api', prefixes)).toBe(true);
	});

	it('leaves everything Vite and Vitest serve alone', () => {
		const prefixes = ['/api', '/media', '/projects'];

		for (const path of [
			'/@vite/client',
			'/@fs/srv/app/node_modules/x.js',
			'/node_modules/vitest/dist/browser.js?v=1',
			'/__vitest__/favicon.svg',
			'/__vitest_browser__/tester.js',
			'/src/web/Timeline.svelte',
			'/apiary',
			'/'
		]) {
			expect(isAppRequest(path, prefixes), path).toBe(false);
		}
	});
});

describe('the stub itself', () => {
	it('is off unless Vitest is running Vite, so `vite dev` still serves the app', () => {
		const applies = (enabled: boolean) => {
			const apply = stubAppRoutes({ enabled }).apply as () => boolean;
			return apply();
		};

		expect(applies(false)).toBe(false);
		expect(applies(true)).toBe(true);
	});

	it('answers a claimed request with 204 and passes anything else on', () => {
		const plugin = stubAppRoutes({ enabled: true, prefixes: ['/api'] });
		const server = { middlewares: { use: (fn: unknown) => (used = fn) } };
		let used: unknown;

		// The hook returns the installer Vite runs after its own middlewares —
		// which is where SvelteKit's dev handler lives too, one plugin later.
		// Vite types a hook as "function or { handler }"; this one is a function.
		const hook = plugin.configureServer as (server: unknown) => () => void;
		const install = hook(server);
		install();
		const middleware = used as (
			req: { url?: string },
			res: { statusCode: number; end: (body?: string) => void },
			next: () => void
		) => void;

		const claimed = { statusCode: 200, ended: false, end: () => (claimed.ended = true) };
		middleware({ url: '/api/stream' }, claimed, () => expect.unreachable('passed on /api/stream'));
		// 204, and no body: a navigation answered this way does not move the page.
		expect(claimed).toMatchObject({ statusCode: 204, ended: true });

		let passedOn = false;
		middleware({ url: '/@vite/client' }, { statusCode: 200, end: () => {} }, () => {
			passedOn = true;
		});
		expect(passedOn).toBe(true);
	});
});
