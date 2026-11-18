/**
 * Apps: a piece of interactive UI an agent supplies, drawn on a card.
 *
 * The owner: "I want apps to be able to embed UI directly into the dashboard,
 * would be awesome to support it", pointing at MCP Apps (SEP-1865) — the
 * extension where a tool result is rendered as a real interface instead of a
 * paragraph about one.
 *
 * ## This dashboard is the host, which is the other way round from the spec
 *
 * In MCP Apps the *client* (Claude, ChatGPT) is the host and the MCP *server*
 * supplies the UI. Here the dashboard is the MCP server and the agent is the
 * client, so the roles swap: the agent supplies the interface, and the
 * dashboard — the thing with a screen and a human in front of it — hosts it.
 *
 * Everything else is kept verbatim from the spec, so an app written for any
 * other host runs here unchanged: the `ui://` URI, the
 * `text/html;profile=mcp-app` body, the JSON-RPC-over-postMessage handshake.
 *
 * ## Two tables, for the reason embeds have two
 *
 * - **`apps` is the interface.** Registered once by URI and upserted, because
 *   registering is what an agent does at the top of every run and the second run
 *   must leave the same one row.
 * - **`app_views` is one showing of it.** It carries the values this instance
 *   was opened with and the card it hangs on, and names the app it is drawn in.
 *
 * So an agent ships `ui://sprint-board` once and puts twenty of them on twenty
 * cards, and correcting the HTML later corrects all twenty.
 *
 * ## `html` is real markup here, and that is the whole difference from embeds
 *
 * An embed spec is a closed vocabulary precisely because an embed is drawn on
 * the dashboard's own origin (migration 027). An app is not: it is loaded into
 * an iframe with no `allow-same-origin`, so the document runs on an opaque
 * origin with no access to the owner's cookies, storage or DOM, under a
 * Content-Security-Policy this deployment writes. That sandbox is what buys the
 * freedom — the markup is arbitrary because it can do nothing with the page it
 * sits in except talk over `postMessage`, and every message is checked.
 *
 * `csp` stores the extra origins an app declared (`_meta.ui.csp` in the spec:
 * `connect`, `resource`, `frame`). Empty by default, which means an app reaches
 * nothing at all unless it said what it needs.
 *
 * ## `state` belongs to the view, not to the agent
 *
 * The iframe has no `localStorage` — an opaque origin has none worth having —
 * so a collapsed section or a half-filled form would be lost on every render.
 * `state` is where the app puts that, written by the app itself through the
 * bridge. `data` is the other direction: what the agent sent it.
 */
export const sql = `
CREATE TABLE apps (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	-- The spec's own handle, e.g. 'ui://review-board'. Unique, and what an agent
	-- names when it shows one.
	uri TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	description TEXT,
	-- Who registered it. NULL would mean one this deployment ships; there are
	-- none yet, and the column is nullable so there can be.
	agent_id TEXT REFERENCES agents (id),
	-- The document itself: text/html;profile=mcp-app, served into a sandboxed
	-- iframe and never into this page.
	html TEXT NOT NULL,
	-- The origins it declared, as JSON: { connect: [], resource: [], frame: [] }.
	-- Anything not named here is refused by the policy the route sends.
	csp TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE app_views (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	app_id TEXT NOT NULL REFERENCES apps (id),
	-- Exactly one of these, the generic card anchor every card feature uses
	-- (migration 034).
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	request_id TEXT REFERENCES approvals (id),
	agent_id TEXT REFERENCES agents (id),
	-- 'human' or 'agent:<id>', the vocabulary every other card feature uses.
	author TEXT NOT NULL,
	-- What the agent handed this instance, as JSON. Delivered to the frame as the
	-- spec's ui/notifications/tool-result.
	data TEXT NOT NULL,
	-- What the app itself saved, as JSON, or NULL if it never has.
	state TEXT,
	-- A line of text above the frame, so a collapsed app still says what it is.
	title TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

-- The reads the feed makes: every app on the cards it is rendering.
CREATE INDEX app_views_update ON app_views (update_id);
CREATE INDEX app_views_message ON app_views (message_id);
CREATE INDEX app_views_request ON app_views (request_id);
`;
