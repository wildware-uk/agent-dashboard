/**
 * Vite plugins that exist only for the test runs (issue #21).
 *
 * The component project renders real components in a real browser, and a real
 * component asks for real URLs: `/api/stream` for the event stream, `/media/…`
 * for a thumbnail, `/projects/…` behind a link. There is no server in a
 * component test to answer them, but there *is* a full SvelteKit plugin on that
 * Vite server, so each of those requests reached SvelteKit's dev handler, which
 * cannot initialise a server inside the browser runner and threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'wrapDynamicImport')
 *         at Server.init (…/@sveltejs/kit/src/runtime/server/index.js)
 *
 * once per request, to the terminal, unattached to any test — which is why the
 * traces appeared *after* the summary of a run that passed. Answering those
 * requests here, before SvelteKit sees them, is both quiet and true: in a
 * component test nothing is serving the app.
 *
 * The answer is `204 No Content` rather than a 404, because some of those
 * requests are navigations — a link in the sidebar, a form the owner submits —
 * and a browser told 204 stays exactly where it is. Anything else would move the
 * runner's iframe off the page the test is running on.
 */
import { readdirSync } from 'node:fs';
import type { Plugin } from 'vite';

/** The SvelteKit route tree (mirrored in `vite.config.ts`'s `files.routes`). */
const ROUTES_DIR = new URL('./src/http/routes/', import.meta.url);

/**
 * The app's own top-level URLs, read off the route tree rather than listed.
 *
 * A slice that adds `src/http/routes/tasks/` gets the same treatment without
 * anyone remembering this file exists.
 */
export function appRoutePrefixes(dir: URL = ROUTES_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `/${entry.name}`);
}

/**
 * Does this request belong to the app rather than to the runner?
 *
 * Matched a whole segment at a time, so `/apiary` is not `/api`, and never at
 * the root: `/` is what the browser runner itself is served on.
 */
export function isAppRequest(url: string, prefixes: readonly string[]): boolean {
	const path = url.split('?')[0];
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export type StubAppRoutesOptions = {
	/** Defaults to "only when Vitest is the one running Vite". */
	enabled?: boolean;
	/** Defaults to {@link appRoutePrefixes}. */
	prefixes?: readonly string[];
};

/**
 * Answer the app's own URLs with `204 No Content` during a test run.
 *
 * Installed from the *returned* `configureServer` hook, so it sits after Vite's
 * own middlewares and before SvelteKit's catch-all dev handler — which requires
 * this plugin to come before `sveltekit()` in the plugins array, since Vite runs
 * those post-hooks in plugin order.
 */
export function stubAppRoutes(options: StubAppRoutesOptions = {}): Plugin {
	const enabled = options.enabled ?? Boolean(process.env.VITEST);
	const prefixes = options.prefixes ?? (enabled ? appRoutePrefixes() : []);

	return {
		name: 'stub-app-routes-in-tests',
		// Off entirely unless a test run asked for it: `vite dev` and `vite build`
		// must keep serving the app they exist to serve.
		apply: () => enabled,
		configureServer(server) {
			return () => {
				server.middlewares.use((req, res, next) => {
					if (!isAppRequest(req.url ?? '', prefixes)) return next();
					// 204 keeps a navigation on the current page; a body would move it.
					res.statusCode = 204;
					res.end();
				});
			};
		}
	};
}
