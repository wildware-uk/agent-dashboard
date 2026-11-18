/**
 * `register_app` (migration 041) — shipping an interface, not a paragraph.
 *
 * The owner asked for MCP Apps (SEP-1865) support: "I want apps to be able to
 * embed UI directly into the dashboard." This is the half an agent calls.
 *
 * The description below carries the *whole* protocol, because an agent writes
 * the document in one shot and has no way to ask what `ui/initialize` is. It
 * also says plainly what the sandbox refuses — no network unless declared, no
 * storage, no parent page — so an app is not written against a browser it does
 * not have.
 */
import {
	APP_CSP_ORIGINS_MAX,
	APP_DESCRIPTION_MAX_LENGTH,
	APP_HTML_MAX_LENGTH,
	APP_MIME,
	APP_NAME_MAX_LENGTH,
	APP_URI_MAX_LENGTH,
	APP_URL_MAX_LENGTH,
	registerApp
} from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	uri: z
		.string()
		.max(APP_URI_MAX_LENGTH)
		.describe(
			`The app's handle, e.g. "ui://review-board". The MCP Apps scheme: ui:// followed by ` +
				`lowercase words. Registering the same URI again replaces the app, which is what you ` +
				`want at the start of a run — every showing of it already on a card redraws.`
		),
	name: z.string().max(APP_NAME_MAX_LENGTH).describe('What to call it for a human.'),
	description: z
		.string()
		.max(APP_DESCRIPTION_MAX_LENGTH)
		.optional()
		.describe('One line saying what it is for. Shown above the frame.'),
	html: z
		.string()
		.max(APP_HTML_MAX_LENGTH)
		.optional()
		.describe(
			`One self-contained HTML document: markup, CSS and script in the one file. ` +
				`Served as ${APP_MIME} into a sandboxed frame. Give this OR url, never both.`
		),
	url: z
		.string()
		.max(APP_URL_MAX_LENGTH)
		.optional()
		.describe(
			`An https page an existing service already serves, framed directly, e.g. ` +
				`"https://fix.example.com/embed?query=open". Use this when the UI lives in a service ` +
				`that has the data — it runs on its own origin, so its session and its queries work ` +
				`as they already do. Give this OR html, never both.`
		),
	csp: z
		.object({
			connect: z.array(z.string()).optional(),
			resource: z.array(z.string()).optional(),
			frame: z.array(z.string()).optional()
		})
		.optional()
		.describe(
			`Origins this app needs, the spec's _meta.ui.csp. https origins only, at most ` +
				`${APP_CSP_ORIGINS_MAX} each. Anything you do not name here, the app cannot reach.`
		)
};

export const registerAppTool: McpTool<typeof inputSchema> = {
	name: 'register_app',
	config: {
		title: 'Register an app',
		description: [
			'Ship a real interface to your owner instead of describing one: a review board they can',
			'tick through, a diff they can accept, a chart of the run you are in the middle of. The',
			'dashboard renders it on a card, live, and it can call back into the dashboard.',
			'',
			'This is the MCP Apps extension (SEP-1865) with the roles the other way round. There,',
			'the client is the host and the server supplies the UI; here the dashboard is the host —',
			'it is the end with a screen and a human in front of it — and you are the server. The',
			'wire format is unchanged, so an app you wrote for any other host runs here as it is.',
			'',
			'Two steps: register the app once, then pass `apps` to post_update or post_message as',
			'often as you like. set_app_data pushes fresh values into one already on a card.',
			'',
			'## Two kinds, and you pick one',
			'',
			'- **html** — a self-contained document you write. The dashboard serves and sandboxes it,',
			'  and YOU give it its data (with `apps[].data`, then set_app_data). Right when the data',
			'  is something you have and nothing else serves.',
			'- **url** — an https page a service already serves, framed directly. Right when the UI',
			'  lives in a service that HAS the data: an internal dashboard, a build view, a report.',
			'  It runs on its own origin, so its own session, its own queries and its own live',
			'  updates work exactly as they already do — you are not relaying anything.',
			'',
			'For a url app the rest of this description is optional: the page may speak the bridge',
			'below if it wants theme, the card it is on, or to post back, and if it speaks nothing it',
			'is simply a live view on the card. Two things it must do: allow framing by this',
			'dashboard (no `X-Frame-Options: DENY`, and a `frame-ancestors` that names it), and be',
			"reachable by the owner's browser. Anything it needs identity for must work as a",
			'third-party frame — a signed link the agent puts in the URL is the usual answer, since a',
			'`SameSite=Lax` cookie is not sent to a framed page.',
			'',
			'## What the app runs in',
			'',
			'An iframe with sandbox="allow-scripts" and NO allow-same-origin, under a',
			'Content-Security-Policy this dashboard writes. In practice that means:',
			'',
			'- no cookies, no localStorage, no sessionStorage, no IndexedDB — they throw or are',
			'  empty. Keep state with ui/state-changed below, which survives a reload and is',
			'  restored to you on the next open.',
			'- no network at all unless you declared the origin in `csp`. No CDNs: inline your CSS',
			'  and your script. A framework you cannot inline is a framework this will not run.',
			'- no reach into the dashboard page, and no navigation of it.',
			'',
			'That sandbox is why the markup may be anything: it cannot touch the session it is drawn',
			'in. Write plain HTML and a little script.',
			'',
			'## Talking to the dashboard',
			'',
			'JSON-RPC 2.0 over window.parent.postMessage(message, "*"), exactly as the spec writes',
			'it. Open with:',
			'',
			'```js',
			'parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize",',
			'  params: { protocolVersion: "2026-01-26", capabilities: {},',
			'            clientInfo: { name: "review-board", version: "1.0.0" } } }, "*");',
			'```',
			'',
			'The host answers that id with { protocolVersion, hostInfo, hostCapabilities,',
			'hostContext }. hostContext carries { theme: "light"|"dark", locale,',
			'containerDimensions: { maxHeight }, card: { kind, id }, view: { id }, data, state }.',
			'`data` is what was passed with `apps` (or the last set_app_data); `state` is whatever',
			'the app saved for itself last time. Then send:',
			'',
			'```js',
			'parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized",',
			'  params: {} }, "*");',
			'```',
			'',
			'Nothing is sent to the app before that notification arrives, so send it.',
			'',
			'The host then pushes, as notifications you listen for on window "message":',
			'',
			'- ui/notifications/tool-input  { arguments } — the data, as it arrived.',
			'- ui/notifications/tool-result { content, structuredContent } — the same data in the',
			"  spec's result shape, and again whenever set_app_data changes it. Re-render on this.",
			'- ui/notifications/theme-changed { theme } — the owner switched light/dark.',
			'',
			'And listens for, from the app:',
			'',
			'- ui/notifications/size-changed { width, height } — how tall you want to be. Send it',
			'  after you render and whenever the content changes height, or the frame stays short.',
			'- ui/notifications/state-changed { state } — an object to keep for this showing. It is',
			'  handed back in hostContext.state next time. At most a few kilobytes; use it for the',
			'  open tab and the half-filled form, not for your data.',
			'- tools/call { name, arguments } — see below.',
			'',
			'## What tools/call reaches',
			'',
			'NOT your tools: your process is not on the other end of this frame, the dashboard is,',
			'and the person clicking is your owner. So a call is the OWNER acting on the card your',
			'app is on, and it is recorded as them. Four names, and every one of them is scoped to',
			'that card — there is no argument for which card, deliberately:',
			'',
			"- post_message { body }            — write a comment in the card's thread.",
			'- set_status   { status }          — "todo", "in_progress", "blocked", "done".',
			'- set_field    { name, value }     — set or correct a note on the card; value: null',
			'                                     takes it off.',
			'- react        { emoji }           — put an emoji on the card.',
			'',
			'Each answers the JSON-RPC id with { content: [...] } or an error object. That is how an',
			'app gets an answer back to you: your owner presses "Looks good" in your app, the',
			'dashboard posts it as a comment, and it reaches you the way every other reply does.',
			'',
			'## A whole app, small enough to read',
			'',
			'```html',
			'<!doctype html><meta charset="utf-8">',
			'<style>body{font:14px system-ui;margin:0;padding:12px}button{padding:6px 10px}</style>',
			'<p id="line">…</p><button id="go">Looks good</button>',
			'<script>',
			'  let next = 2;',
			'  const send = (m) => parent.postMessage({ jsonrpc: "2.0", ...m }, "*");',
			'  const fit = () => send({ method: "ui/notifications/size-changed",',
			'    params: { width: document.body.scrollWidth, height: document.body.scrollHeight } });',
			'  addEventListener("message", (e) => {',
			'    const m = e.data;',
			'    if (m?.id === 1 && m.result) {',
			'      render(m.result.hostContext.data);',
			'      send({ method: "ui/notifications/initialized", params: {} });',
			'    }',
			'    if (m?.method === "ui/notifications/tool-result") render(m.params.structuredContent);',
			'  });',
			'  function render(data) { line.textContent = (data?.open ?? 0) + " to review"; fit(); }',
			'  go.onclick = () => send({ id: next++, method: "tools/call",',
			'    params: { name: "post_message", arguments: { body: "Looks good." } } });',
			'  send({ id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26",',
			'    capabilities: {}, clientInfo: { name: "review", version: "1.0.0" } } });',
			'</script>',
			'```',
			'',
			'Arguments:',
			`- uri (required): ui:// followed by lowercase words, at most ${APP_URI_MAX_LENGTH} characters.`,
			`- name (required): what a human calls it, at most ${APP_NAME_MAX_LENGTH} characters.`,
			`- html: one self-contained document, at most ${APP_HTML_MAX_LENGTH} characters.`,
			`- url: an https page to frame instead, at most ${APP_URL_MAX_LENGTH} characters.`,
			'  Exactly one of html and url is required.',
			'- description (optional): one line, shown above the frame.',
			'- csp (optional): { connect, resource, frame } — https origins the app may reach.',
			'',
			'Returns { uri, name, url, bytes, csp }. On failure: "invalid_argument" names what did',
			'not hold up — a handle that is not ui://, neither html nor url, both of them, an',
			'oversized document, a url that is not https, a declared origin that is not a plain https',
			'origin. "conflict" means another agent registered that URI.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const app = registerApp(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				uri: args.uri,
				name: args.name,
				description: args.description,
				html: args.html,
				url: args.url,
				csp: args.csp
			});

			return ok(
				`Registered "${app.uri}"${app.url ? `, framing ${app.url}` : ''}. Pass apps: ` +
					`[{ app: "${app.uri}", data: { ... } }] to post_update or post_message to show it.`,
				{ uri: app.uri, name: app.name, url: app.url, bytes: app.bytes, csp: app.csp }
			);
		})
};
