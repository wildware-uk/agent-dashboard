/**
 * Apps: interactive UI an agent supplies, hosted on a card (migration 041).
 *
 * The owner, pointing at the MCP Apps extension (SEP-1865): "I want apps to be
 * able to embed UI directly into the dashboard, would be awesome to support it."
 *
 * ## The roles are swapped, and nothing else is
 *
 * In MCP Apps the client — Claude, ChatGPT — is the *host*, and the MCP server
 * it connected to supplies the interface. Here the dashboard is the MCP server
 * and the agent is the client, so the host is this end: the one with a screen
 * and a human in front of it.
 *
 * Everything below the roles is kept exactly as the spec writes it, so an app
 * written for any other host runs here unchanged:
 *
 * - the handle is a `ui://` URI;
 * - the body is `text/html;profile=mcp-app`, self-contained;
 * - the frame talks JSON-RPC 2.0 over `postMessage`, opening with
 *   `ui/initialize` and answering `ui/notifications/initialized`;
 * - the host pushes `ui/notifications/tool-input` and
 *   `ui/notifications/tool-result`, and listens for
 *   `ui/notifications/size-changed`;
 * - declared origins live in `_meta.ui.csp` as `connect`, `resource`, `frame`.
 *
 * ## Why an app may be markup when an embed may not
 *
 * An embed is a closed vocabulary because an embed is drawn *on this page*
 * (`./embeds.ts`). An app is not drawn on this page at all: it is loaded into an
 * iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, which puts
 * it on an opaque origin — no cookies, no storage, no reach into the dashboard's
 * DOM — under a Content-Security-Policy this deployment writes and the app only
 * gets to widen by naming origins here, up front, where the owner can see them.
 *
 * So the sandbox is the security boundary, and this module's job is to make sure
 * nothing can get out from behind it: the URI is checked, the size is capped,
 * the declared origins must be plain `https` origins, and the data an app is
 * handed is JSON rather than anything that could be markup.
 *
 * ## Two kinds of app (migration 042)
 *
 * The owner: "what about the actual downstream service that must render the UI?
 * I have a fix dashboard, I'd like the agent to be able to include an iframe
 * directly from that, with live results from a query."
 *
 * So an app is one of two things, and exactly one:
 *
 * - **`html`** — a document this deployment serves and sandboxes. The agent
 *   wrote it, so it runs with no origin worth having and is *given* its data.
 * - **`url`** — an https page a service already serves. The dashboard frames it
 *   directly, and it runs on **its own** origin: its session works, its queries
 *   are its own, and "live" means what it already means over there.
 *
 * `allow-same-origin` on that second frame is safe precisely because the origin
 * in question is the service's, not the dashboard's: the page is cross-origin
 * from this session either way and can read no more of it than any other
 * third-party frame can. What it buys is the service's own cookies, which is the
 * whole reason to point at a service instead of shipping a document.
 *
 * ## Two directions of state, on purpose
 *
 * `data` is what the agent handed this showing. `state` is what the app saved
 * for itself — the opened tab, the half-filled form — because an opaque origin
 * has no `localStorage` worth having. They are separate columns so an agent
 * pushing fresh numbers cannot wipe out what the owner was in the middle of.
 */
import {
	findAppById,
	findAppByUri,
	findAppView,
	insertAppView,
	listAppViews,
	listApps,
	updateAppViewData,
	updateAppViewState,
	upsertApp,
	type App,
	type AppView,
	type CardKind,
	type CardRef
} from '$db';
import { announceCard, resolveCard } from './cards';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';

export type { App, AppView };

/** How an agent names an app. The spec's scheme, and nothing else. */
export const APP_URI_SCHEME = 'ui://';

/** The part after `ui://`: lowercase words, slashes allowed for a family. */
export const APP_URI_PATH = /^[a-z0-9]+(?:[-.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-.][a-z0-9]+)*)*$/;

export const APP_URI_MAX_LENGTH = 120;
export const APP_NAME_MAX_LENGTH = 80;
export const APP_DESCRIPTION_MAX_LENGTH = 400;

/**
 * The biggest document an app may be.
 *
 * Generous, because the spec asks an app to be self-contained — its CSS and its
 * script are in the one file — and mean, because this is stored per app and
 * shipped to a browser on a card. A quarter of a megabyte is a real interface
 * and is not a bundled framework.
 */
export const APP_HTML_MAX_LENGTH = 250_000;

/** The longest a framed page's address may be. */
export const APP_URL_MAX_LENGTH = 2_000;

/** The mime the spec gives an app's body. */
export const APP_MIME = 'text/html;profile=mcp-app';

/** Most origins an app may declare in any one of the three CSP lists. */
export const APP_CSP_ORIGINS_MAX = 10;

/** Most apps one card may carry. A card, not a desktop. */
export const APPS_PER_POST_MAX = 4;

/** How much an agent may hand one showing, as JSON text. */
export const APP_DATA_MAX_LENGTH = 100_000;

/** How much an app may save for itself, as JSON text. */
export const APP_STATE_MAX_LENGTH = 20_000;

export const APP_TITLE_MAX_LENGTH = 120;

/**
 * The origins an app asked for, the spec's three lists.
 *
 * `connect` becomes `connect-src`, `resource` becomes `img-src`/`font-src`/
 * `media-src`/`style-src`, `frame` becomes `frame-src`. Anything an app does not
 * name, it cannot reach: the default policy is `default-src 'none'`.
 */
export type AppCsp = {
	connect: string[];
	resource: string[];
	frame: string[];
};

export const EMPTY_CSP: AppCsp = { connect: [], resource: [], frame: [] };

/** One app, as a tool result or a list entry describes it. */
export type AppSummary = {
	uri: string;
	name: string;
	description: string | null;
	csp: AppCsp;
	/** The page this app frames, or `null` for a document we serve (042). */
	url: string | null;
	/** How big the document is, which is the one number worth reporting back. */
	bytes: number;
	/** Whether the agent asking registered it. */
	mine: boolean;
	updatedAt: number;
};

/** One showing of an app, as the dashboard renders it. */
export type AppViewData = {
	id: string;
	card: CardRef;
	/** The app's handle, so a client can tell two showings apart. */
	uri: string;
	name: string;
	description: string | null;
	/** The page to frame, or `null` for a document this deployment serves (042). */
	url: string | null;
	title: string | null;
	/** What the agent handed it. */
	data: Record<string, unknown>;
	/** What the app saved for itself, or `null` if it never has. */
	state: Record<string, unknown> | null;
	author: string;
	agentId: string | null;
	createdAt: number;
	updatedAt: number;
};

export type RegisterAppInput = {
	/** From the bearer token, never an argument (design §5). */
	agentId: string;
	uri: string;
	name: string;
	description?: string | null;
	/** A self-contained document. Exactly one of this and `url`. */
	html?: string;
	/** An https page to frame instead (migration 042). */
	url?: string;
	csp?: unknown;
};

/**
 * Register an app, or replace the one that URI already names.
 *
 * @throws {DomainError} `invalid_argument` for a URI that is not `ui://…`, an
 *   empty or oversized document, or a declared origin that is not a plain
 *   `https` origin; `conflict` when another agent registered that URI.
 */
export function registerApp(ctx: DomainContext, input: RegisterAppInput): AppSummary {
	const uri = parseAppUri(input.uri, 'uri');

	const name = input.name.trim();
	if (name.length === 0 || name.length > APP_NAME_MAX_LENGTH) {
		throw invalid(`name is required, and at most ${APP_NAME_MAX_LENGTH} characters`);
	}

	const description = (input.description ?? '').trim();
	if (description.length > APP_DESCRIPTION_MAX_LENGTH) {
		throw invalid(`description may be at most ${APP_DESCRIPTION_MAX_LENGTH} characters`);
	}

	// One or the other, never both: a document and a page to frame are two
	// different apps, and an app that carried both would leave the dashboard
	// guessing which one the agent meant.
	const wantsHtml = typeof input.html === 'string' && input.html.trim() !== '';
	const wantsUrl = typeof input.url === 'string' && input.url.trim() !== '';
	if (wantsHtml && wantsUrl) {
		throw invalid('give html or url, not both: an app is a document, or a page to frame');
	}
	if (!wantsHtml && !wantsUrl) {
		throw invalid('an app needs html — a self-contained document — or url, an https page to frame');
	}

	const html = wantsHtml ? (input.html as string) : '';
	if (html.length > APP_HTML_MAX_LENGTH) {
		throw invalid(
			`html may be at most ${APP_HTML_MAX_LENGTH} characters. An app is one self-contained ` +
				`document, so split the work between the app and tool calls rather than shipping a bundle.`
		);
	}

	const url = wantsUrl ? parseAppPage(input.url, 'url') : null;

	const csp = parseAppCsp(input.csp, 'csp');

	const existing = findAppByUri(ctx.db, uri);
	if (existing && existing.agentId !== input.agentId) {
		throw conflict(
			existing.agentId === null
				? `"${uri}" is one of the apps this dashboard ships, so it cannot be redefined.`
				: `"${uri}" was registered by another agent. Pick a different URI.`
		);
	}

	const row = upsertApp(ctx.db, {
		uri,
		name,
		description: description === '' ? null : description,
		agentId: input.agentId,
		html,
		url,
		csp: JSON.stringify(csp),
		at: ctx.now()
	});

	return summary(row, input.agentId);
}

/** Every app registered here, for an agent deciding whether to write one. */
export function listAppSummaries(ctx: DomainContext, agentId: string | null): AppSummary[] {
	return listApps(ctx.db).map((row) => summary(row, agentId));
}

function summary(row: App, agentId: string | null): AppSummary {
	return {
		uri: row.uri,
		name: row.name,
		description: row.description,
		csp: cspOf(row),
		url: row.url,
		bytes: Buffer.byteLength(row.html, 'utf8'),
		mine: agentId !== null && row.agentId === agentId,
		updatedAt: row.updatedAt
	};
}

/** What a post says it wants shown. */
export type NewAppInput = {
	/** The app's `ui://` URI. */
	app?: unknown;
	/** What to hand it, as a JSON object. */
	data?: unknown;
	/** A line above the frame, for a collapsed app. */
	title?: unknown;
};

export type CheckedApp = {
	appId: string;
	data: string;
	title: string | null;
};

/**
 * Check the apps a post carried, before any of it is written.
 *
 * Same rule and same reason as `checkedEmbeds`: an unknown app is caught while
 * there is still nothing to undo, so a post either goes up whole or is refused
 * having said which app was wrong.
 */
export function checkedApps(ctx: DomainContext, apps: readonly NewAppInput[]): CheckedApp[] {
	if (apps.length > APPS_PER_POST_MAX) {
		throw invalid(`a post may carry at most ${APPS_PER_POST_MAX} apps`);
	}

	return apps.map((entry, at) => {
		const uri = parseAppUri(entry.app, `apps[${at}].app`);
		const app = findAppByUri(ctx.db, uri);
		if (!app) {
			throw invalid(
				`apps[${at}]: no app "${uri}". Call register_app to ship it, or list_apps to see ` +
					`what is already registered.`
			);
		}

		return {
			appId: app.id,
			data: parseAppData(entry.data, `apps[${at}].data`, APP_DATA_MAX_LENGTH),
			title: parseTitle(entry.title, `apps[${at}].title`)
		};
	});
}

export type AttachAppsInput = {
	apps: readonly CheckedApp[];
	card: CardRef;
	agentId?: string | null;
	author: string;
};

/** Write the apps a post carried. Already checked by {@link checkedApps}. */
export function attachApps(ctx: DomainContext, input: AttachAppsInput): AppView[] {
	return input.apps.map((app) =>
		insertAppView(ctx.db, {
			appId: app.appId,
			card: input.card,
			agentId: input.agentId ?? null,
			author: input.author,
			data: app.data,
			title: app.title,
			at: ctx.now()
		})
	);
}

export type SetAppDataInput = {
	viewId: string;
	data: unknown;
	title?: unknown;
};

/**
 * Hand a showing fresh data, live.
 *
 * This is what makes an app an app rather than a screenshot: the agent that put
 * a build board on a card pushes the next build into it, and every open tab
 * redraws. What the *app* saved is untouched — see the note at the top.
 *
 * Nobody owns a showing. Any agent may update one, for the reason nobody owns a
 * field (`./fields.ts`): what an app is showing is a fact about the work, not a
 * statement somebody made and may not have taken back.
 */
export function setAppData(ctx: DomainContext, input: SetAppDataInput): AppViewData {
	const view = findAppView(ctx.db, input.viewId);
	if (!view) throw notFound(`no app view ${JSON.stringify(input.viewId)}`);

	const row = resolveCard(ctx, view.card);
	const data = parseAppData(input.data, 'data', APP_DATA_MAX_LENGTH);
	const title = input.title === undefined ? undefined : parseTitle(input.title, 'title');

	const updated = updateAppViewData(ctx.db, view.id, data, title, ctx.now());
	if (!updated) throw notFound(`no app view ${JSON.stringify(input.viewId)}`);

	announceCard(ctx, view.card, row);
	ctx.bus.publish('apps.changed', { projectId: row.projectId });

	return viewData(ctx, updated)!;
}

/**
 * Save what the app itself is holding.
 *
 * Called by the frame through the bridge, which is to say: by the owner, who is
 * the one clicking. It is not announced on the bus — the state is the app's own
 * scratch paper, and redrawing every open tab because somebody opened a section
 * would be worse than the tabs disagreeing about which section is open.
 */
export function saveAppState(ctx: DomainContext, viewId: string, state: unknown): AppViewData {
	const view = findAppView(ctx.db, viewId);
	if (!view) throw notFound(`no app view ${JSON.stringify(viewId)}`);
	// The card still has to exist: state on a deleted card is a write to nothing.
	resolveCard(ctx, view.card);

	const text =
		state === null || state === undefined
			? null
			: parseAppData(state, 'state', APP_STATE_MAX_LENGTH);

	const updated = updateAppViewState(ctx.db, viewId, text, ctx.now());
	if (!updated) throw notFound(`no app view ${JSON.stringify(viewId)}`);
	return viewData(ctx, updated)!;
}

/** One showing, by id, for the route that serves its document. */
export function appViewById(ctx: DomainContext, id: string): AppViewData | undefined {
	const row = findAppView(ctx.db, id);
	return row && viewData(ctx, row);
}

/**
 * The document and policy one showing renders with.
 *
 * `undefined` for an app that lives somewhere else (migration 042): there is
 * nothing here to serve, because the card frames the service's own page.
 */
export function appDocument(
	ctx: DomainContext,
	viewId: string
): { html: string; csp: AppCsp } | undefined {
	const view = findAppView(ctx.db, viewId);
	if (!view) return undefined;
	const app = findAppById(ctx.db, view.appId);
	if (!app || app.url !== null) return undefined;
	return { html: app.html, csp: cspOf(app) };
}

/** Which cards to read apps for, by kind. */
export type AppScope = Partial<Record<CardKind, readonly string[]>>;

/** Every app showing on these cards, for a page of the feed. */
export function appsForCards(ctx: DomainContext, scope: AppScope): AppViewData[] {
	return listAppViews(ctx.db, scope)
		.map((row) => viewData(ctx, row))
		.filter((view): view is AppViewData => view !== undefined);
}

/** Every app showing on one card. */
export function appsOn(ctx: DomainContext, card: CardRef): AppViewData[] {
	return appsForCards(ctx, { [card.kind]: [card.id] });
}

function viewData(ctx: DomainContext, row: AppView): AppViewData | undefined {
	const app = findAppById(ctx.db, row.appId);
	if (!app) return undefined;

	return {
		id: row.id,
		card: row.card,
		uri: app.uri,
		name: app.name,
		description: app.description,
		url: app.url,
		title: row.title,
		data: readJson(row.data),
		state: row.state === null ? null : readJson(row.state),
		author: row.author,
		agentId: row.agentId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** Stored JSON back as an object, and `{}` for anything that will not parse. */
function readJson(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// A row written by an older shape, or by hand. An app that gets `{}` still
		// renders; one that got a crash would take the card down with it.
	}
	return {};
}

function cspOf(app: App): AppCsp {
	try {
		return parseAppCsp(JSON.parse(app.csp), 'csp');
	} catch {
		return EMPTY_CSP;
	}
}

/** The `ui://…` handle, checked. */
export function parseAppUri(raw: unknown, field: string): string {
	if (typeof raw !== 'string') throw invalid(`${field} must be a ui:// URI`);
	const uri = raw.trim().toLowerCase();

	if (!uri.startsWith(APP_URI_SCHEME)) {
		throw invalid(`${field} must start with ${APP_URI_SCHEME}, e.g. "ui://review-board"`);
	}
	if (uri.length > APP_URI_MAX_LENGTH) {
		throw invalid(`${field} may be at most ${APP_URI_MAX_LENGTH} characters`);
	}

	const path = uri.slice(APP_URI_SCHEME.length);
	if (!APP_URI_PATH.test(path)) {
		throw invalid(
			`${field} must be ${APP_URI_SCHEME} followed by lowercase words, e.g. ` +
				`"ui://review-board" or "ui://acme/review-board"`
		);
	}

	return uri;
}

/**
 * The page an app frames, checked (migration 042).
 *
 * `https` only, and a whole address rather than an origin — a service's embed
 * view lives at a path, and usually carries a query naming what to show. What is
 * refused is anything that is not a page a browser would navigate to: a
 * `javascript:` URL, credentials in the address, a fragment that only matters to
 * whoever wrote it.
 */
export function parseAppPage(raw: unknown, field: string): string {
	if (typeof raw !== 'string') throw invalid(`${field} must be an https URL`);

	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw invalid(`${field} must be an absolute https URL, e.g. "https://fix.example.com/embed"`);
	}
	if (url.protocol !== 'https:') {
		throw invalid(
			`${field} must use https: the dashboard is served over it, and a browser ` +
				`refuses to frame an insecure page inside a secure one`
		);
	}
	if (url.username || url.password) throw invalid(`${field} must not carry credentials`);
	if (url.href.length > APP_URL_MAX_LENGTH) {
		throw invalid(`${field} may be at most ${APP_URL_MAX_LENGTH} characters`);
	}
	return url.href;
}

/**
 * The origins an app declared, checked hard.
 *
 * `https` origins only, and an origin is a scheme, a host and an optional port —
 * never a path, never a wildcard, never `data:` or `blob:`. Every one of those
 * exclusions is a way of widening a policy past what the owner would read in the
 * list, and the point of the list is that the owner can read it.
 */
export function parseAppCsp(raw: unknown, field: string): AppCsp {
	if (raw === undefined || raw === null) return { ...EMPTY_CSP };
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalid(`${field} must be an object of { connect, resource, frame }`);
	}

	const source = raw as Record<string, unknown>;
	const csp: AppCsp = { connect: [], resource: [], frame: [] };

	for (const key of ['connect', 'resource', 'frame'] as const) {
		const list = source[key];
		if (list === undefined || list === null) continue;
		if (!Array.isArray(list)) throw invalid(`${field}.${key} must be a list of https origins`);
		if (list.length > APP_CSP_ORIGINS_MAX) {
			throw invalid(`${field}.${key} may name at most ${APP_CSP_ORIGINS_MAX} origins`);
		}
		csp[key] = list.map((entry, at) => parseOrigin(entry, `${field}.${key}[${at}]`));
	}

	return csp;
}

function parseOrigin(raw: unknown, field: string): string {
	if (typeof raw !== 'string') throw invalid(`${field} must be an https origin`);

	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw invalid(`${field} must be an https origin, e.g. "https://api.example.com"`);
	}
	if (url.protocol !== 'https:') throw invalid(`${field} must use https`);
	if (url.username || url.password) throw invalid(`${field} must not carry credentials`);
	if (url.pathname !== '/' || url.search || url.hash) {
		throw invalid(`${field} must be an origin — a host, with no path`);
	}
	return url.origin;
}

/**
 * What an agent hands a showing: a JSON object, as text.
 *
 * An object rather than anything: the spec delivers it as a tool result's
 * `structuredContent`, and an app reads it by name. It is re-serialised here
 * rather than stored as it arrived, so what is in the column is JSON this
 * process wrote.
 */
export function parseAppData(raw: unknown, field: string, maxLength: number): string {
	const value = raw ?? {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw invalid(`${field} must be a JSON object`);
	}

	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		throw invalid(`${field} must be plain JSON — no cycles, no functions`);
	}
	if (text.length > maxLength) {
		throw invalid(`${field} may be at most ${maxLength} characters of JSON`);
	}
	return text;
}

function parseTitle(raw: unknown, field: string): string | null {
	if (raw === undefined || raw === null || raw === '') return null;
	if (typeof raw !== 'string') throw invalid(`${field} must be text`);
	const title = raw.trim();
	if (title.length > APP_TITLE_MAX_LENGTH) {
		throw invalid(`${field} may be at most ${APP_TITLE_MAX_LENGTH} characters`);
	}
	return title === '' ? null : title;
}
