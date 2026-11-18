/**
 * `GET /apps/:view` — the document an app is, served into its sandbox
 * (migration 041).
 *
 * This is the one route on this deployment that answers with HTML an agent
 * wrote, so everything about it is a containment decision.
 *
 * ## The frame, not the headers, is the boundary
 *
 * The card renders this in an iframe with `sandbox="allow-scripts"` and **no**
 * `allow-same-origin`. That single omission is what makes the rest safe: the
 * document lands on an opaque origin, so it has no access to the dashboard's
 * cookies, storage, DOM or session, and nothing it does can be a request *as*
 * the owner. It can only talk through `postMessage`, and the bridge on the other
 * side validates every message (`src/web/appbridge.ts`).
 *
 * The headers here are the second line, and each one is doing a job:
 *
 * - **`Content-Security-Policy`** — `default-src 'none'` with `script-src` and
 *   `style-src` allowing inline only. An app reaches no network at all unless it
 *   declared the origin when it registered, which is a list the owner can read.
 * - **`frame-ancestors 'self'`** — this document is for this dashboard's pages.
 *   Somebody else's page cannot frame it and drive it.
 * - **`X-Content-Type-Options: nosniff`** and an explicit charset — the body is
 *   the mime the spec gives an app and nothing gets to guess otherwise.
 * - **`Cache-Control: no-store`** — an app is replaced by its agent whenever it
 *   likes, and a cached copy of the previous version in a frame that is being
 *   told about new data is the worst of both.
 *
 * ## Why it is addressed by the *showing* rather than by the app
 *
 * `/apps/:view` names one instance on one card. That is what lets the initial
 * payload be this showing's data, and it keeps the URL meaningless to anybody
 * who has not been handed it. The owner's session is still required, because an
 * app is whatever an agent wrote for this owner.
 */
import { appDocument, context, type AppCsp, type DomainContext } from '$domain';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse } from '../stream';

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type AppRequestEvent = {
	params: Partial<Record<'view', string>>;
	cookies: SessionCookieReader;
};

export type AppHandlerOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Session secrets, injectable so tests need no environment. */
	config?: () => AuthConfig | null;
};

export type AppHandler = (event: AppRequestEvent) => Promise<Response>;

/**
 * The policy one app runs under.
 *
 * Built here, from the closed list the domain checked, rather than anywhere an
 * agent's string could reach: every directive is either a literal or an origin
 * that has already been through `parseAppCsp`.
 */
export function policyFor(csp: AppCsp): string {
	const connect = csp.connect.length > 0 ? csp.connect.join(' ') : "'none'";
	const resource = csp.resource.join(' ');
	const frame = csp.frame.length > 0 ? csp.frame.join(' ') : "'none'";

	return [
		`default-src 'none'`,
		// Inline only: an app is one self-contained document, so there is nothing
		// to fetch and no reason to allow fetching one.
		`script-src 'unsafe-inline'`,
		`style-src 'unsafe-inline' ${resource}`.trim(),
		`img-src data: blob: ${resource}`.trim(),
		`font-src data: ${resource}`.trim(),
		`media-src data: blob: ${resource}`.trim(),
		`connect-src ${connect}`,
		`frame-src ${frame}`,
		`form-action 'none'`,
		`base-uri 'none'`,
		// This document is for this dashboard's own pages, and nobody else's.
		`frame-ancestors 'self'`
	].join('; ');
}

function notFound(): Response {
	return new Response(JSON.stringify({ error: 'not_found' }), {
		status: 404,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

/** Build the `GET` handler for `/apps/:view`. */
export function createAppHandler(options: AppHandlerOptions = {}): AppHandler {
	const { context: getContext = context, config } = options;

	return async (event) => {
		if (!ownerAuthenticated(event, config)) return unauthenticatedResponse();

		const id = event.params.view ?? '';
		if (id === '') return notFound();

		const document = appDocument(getContext(), id);
		if (!document) return notFound();

		return new Response(document.html, {
			status: 200,
			headers: {
				// The spec's mime, with the charset said out loud so nothing sniffs.
				'content-type': 'text/html;profile=mcp-app;charset=utf-8',
				'content-security-policy': policyFor(document.csp),
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'no-referrer',
				'cache-control': 'no-store'
			}
		});
	};
}
