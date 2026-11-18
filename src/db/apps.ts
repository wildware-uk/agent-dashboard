/**
 * `apps` and `app_views` (migration 041) — interactive UI an agent supplies.
 *
 * Two tables and one rule between them, the same rule embeds keep: an app is the
 * *interface*, a view is one showing of it. This layer stores and reads them and
 * interprets neither — `html`, `csp`, `data` and `state` are opaque text here,
 * because what counts as a legal app is `$domain/apps.ts`'s question and there
 * should be one answer to it.
 *
 * `author` is the literal `human` or `agent:<agent_id>`, exactly as
 * `messages.author` is (design §3), and this layer does not read it either.
 */
import { CARD_ANCHOR, type CardKind, type CardRef } from './cards';
import type { Db } from './connection';
import { newId } from './ids';
import type { App, AppView } from './types';

type AppRow = {
	seq: number;
	id: string;
	uri: string;
	name: string;
	description: string | null;
	agent_id: string | null;
	html: string;
	url: string | null;
	csp: string;
	created_at: number;
	updated_at: number;
};

const APP_COLUMNS = `seq, id, uri, name, description, agent_id, html, url, csp,
	created_at, updated_at`;

function toApp(row: AppRow): App {
	return {
		seq: row.seq,
		id: row.id,
		uri: row.uri,
		name: row.name,
		description: row.description,
		agentId: row.agent_id,
		html: row.html,
		url: row.url,
		csp: row.csp,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

type ViewRow = {
	seq: number;
	id: string;
	app_id: string;
	update_id: string | null;
	message_id: string | null;
	request_id: string | null;
	agent_id: string | null;
	author: string;
	data: string;
	state: string | null;
	title: string | null;
	created_at: number;
	updated_at: number;
};

const VIEW_COLUMNS = `seq, id, app_id, update_id, message_id, request_id, agent_id, author,
	data, state, title, created_at, updated_at`;

function toView(row: ViewRow): AppView {
	const card: CardRef = row.update_id
		? { kind: 'update', id: row.update_id }
		: row.message_id
			? { kind: 'message', id: row.message_id }
			: { kind: 'request', id: row.request_id! };

	return {
		seq: row.seq,
		id: row.id,
		appId: row.app_id,
		card,
		agentId: row.agent_id,
		author: row.author,
		data: row.data,
		state: row.state,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export function findAppByUri(db: Db, uri: string): App | undefined {
	const row = db
		.prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM apps WHERE uri = ?`)
		.get(uri);
	return row && toApp(row);
}

export function findAppById(db: Db, id: string): App | undefined {
	const row = db.prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).get(id);
	return row && toApp(row);
}

/** Every registered app, by name: the order a list reads in. */
export function listApps(db: Db): App[] {
	return db
		.prepare<[], AppRow>(`SELECT ${APP_COLUMNS} FROM apps ORDER BY name COLLATE NOCASE, uri`)
		.all()
		.map(toApp);
}

export type NewApp = {
	uri: string;
	name: string;
	description: string | null;
	/** The registering agent, or `null` for one this deployment ships. */
	agentId: string | null;
	/** The document, or `''` for an app that is a page somewhere else. */
	html: string;
	/** The page to frame, or `null` for one this deployment serves (042). */
	url: string | null;
	/** The declared origins, as JSON text. Already validated by the caller. */
	csp: string;
	at?: number;
};

/**
 * Register an app, or replace the one that URI already names.
 *
 * An upsert for the reason `upsertEmbedType` is one: registering is how an agent
 * *starts*, it runs the same call every session, and the second run must leave
 * the same one row rather than fail. `created_at` survives — the app was
 * registered once, however many times its markup has been corrected since.
 */
export function upsertApp(db: Db, input: NewApp): App {
	const at = input.at ?? Date.now();

	const row = db
		.prepare<
			[
				string,
				string,
				string,
				string | null,
				string | null,
				string,
				string | null,
				string,
				number,
				number
			],
			AppRow
		>(
			`INSERT INTO apps (id, uri, name, description, agent_id, html, url, csp,
			                   created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (uri) DO UPDATE SET
			   name = excluded.name, description = excluded.description,
			   html = excluded.html, url = excluded.url, csp = excluded.csp,
			   updated_at = excluded.updated_at
			 RETURNING ${APP_COLUMNS}`
		)
		.get(
			newId(),
			input.uri,
			input.name,
			input.description,
			input.agentId,
			input.html,
			input.url,
			input.csp,
			at,
			at
		)!;

	return toApp(row);
}

export type NewAppView = {
	appId: string;
	card: CardRef;
	agentId: string | null;
	author: string;
	/** What this instance was opened with, as JSON text. */
	data: string;
	title: string | null;
	at?: number;
};

/** Put one showing of an app on a card. */
export function insertAppView(db: Db, input: NewAppView): AppView {
	const anchor = CARD_ANCHOR[input.card.kind];
	const at = input.at ?? Date.now();

	const row = db
		.prepare<
			[string, string, string, string | null, string, string, string | null, number, number],
			ViewRow
		>(
			`INSERT INTO app_views (id, app_id, ${anchor}, agent_id, author, data, title,
			                        created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 RETURNING ${VIEW_COLUMNS}`
		)
		.get(
			newId(),
			input.appId,
			input.card.id,
			input.agentId,
			input.author,
			input.data,
			input.title,
			at,
			at
		)!;

	return toView(row);
}

export function findAppView(db: Db, id: string): AppView | undefined {
	const row = db
		.prepare<[string], ViewRow>(`SELECT ${VIEW_COLUMNS} FROM app_views WHERE id = ?`)
		.get(id);
	return row && toView(row);
}

/**
 * Replace what an agent handed one view, leaving what the app saved alone.
 *
 * Two columns, two writers: an agent sending fresh numbers must not wipe out the
 * half-filled form in front of the owner. An omitted `title` is left as it was,
 * which is a different thing from being cleared to `null`.
 */
export function updateAppViewData(
	db: Db,
	id: string,
	data: string,
	title: string | null | undefined,
	at: number
): AppView | undefined {
	const sets =
		title === undefined ? `data = ?, updated_at = ?` : `data = ?, title = ?, updated_at = ?`;
	const args = title === undefined ? [data, at, id] : [data, title, at, id];

	const row = db
		.prepare<unknown[], ViewRow>(
			`UPDATE app_views SET ${sets} WHERE id = ? RETURNING ${VIEW_COLUMNS}`
		)
		.get(...args);
	return row && toView(row);
}

/** Save what the app itself is holding. The other direction from the data. */
export function updateAppViewState(
	db: Db,
	id: string,
	state: string | null,
	at: number
): AppView | undefined {
	const row = db
		.prepare<[string | null, number, string], ViewRow>(
			`UPDATE app_views SET state = ?, updated_at = ? WHERE id = ? RETURNING ${VIEW_COLUMNS}`
		)
		.get(state, at, id);
	return row && toView(row);
}

/**
 * Every app view on these cards, in one query per kind.
 *
 * Ids rather than one card, for the reason every other card read takes a page: a
 * query per card is the fan-out that makes a long feed slow.
 */
export function listAppViews(
	db: Db,
	scope: Partial<Record<CardKind, readonly string[]>>
): AppView[] {
	const found: AppView[] = [];

	for (const [kind, ids] of Object.entries(scope) as [CardKind, readonly string[]][]) {
		if (!ids || ids.length === 0) continue;
		const anchor = CARD_ANCHOR[kind];
		const rows = db
			.prepare<unknown[], ViewRow>(
				`SELECT ${VIEW_COLUMNS} FROM app_views
				  WHERE ${anchor} IN (${ids.map(() => '?').join(', ')})
				  ORDER BY seq`
			)
			.all(...ids);
		found.push(...rows.map(toView));
	}

	return found;
}
