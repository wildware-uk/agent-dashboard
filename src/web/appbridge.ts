/**
 * The host half of MCP Apps, in the browser (migration 041).
 *
 * The owner: "I want apps to be able to embed UI directly into the dashboard."
 * An agent registers a document (`register_app`), the dashboard serves it into a
 * sandboxed frame (`/apps/:view`), and this is what the frame talks to.
 *
 * ## What the protocol is
 *
 * JSON-RPC 2.0 over `postMessage`, exactly as SEP-1865 writes it, so an app
 * written for any other host runs here unchanged:
 *
 * - the view sends `ui/initialize` and is answered with `hostInfo`,
 *   `hostCapabilities` and `hostContext`;
 * - the view then sends `ui/notifications/initialized`, and **nothing is sent to
 *   it before that arrives** — the spec requires it, and it is also the only
 *   thing that tells us a listener exists to hear it;
 * - the host pushes `ui/notifications/tool-input` and
 *   `ui/notifications/tool-result` when the data changes;
 * - the view sends `ui/notifications/size-changed` to ask for a height, and
 *   `tools/call` to do something.
 *
 * ## What it refuses
 *
 * Everything that is not one of those, and everything that is not shaped like
 * JSON-RPC. The frame is on an opaque origin — it is loaded with
 * `sandbox="allow-scripts"` and no `allow-same-origin` — so `event.origin` is
 * the string `"null"` and cannot be checked; the identity check that matters is
 * `event.source === frame.contentWindow`, and the component does it before
 * anything reaches here.
 *
 * ## `tools/call` is the owner acting, not the agent
 *
 * The agent's process is not on the other end of this frame; the dashboard is,
 * and the person pressing the button is the owner. So a call is performed **as
 * the owner**, against **the card the app is on** — there is no argument for
 * which card, deliberately, because an app that could name one could act on a
 * card nobody was looking at. {@link HOST_TOOLS} is the whole list.
 */

/** The spec version this host speaks. */
export const APP_PROTOCOL_VERSION = '2026-01-26';

/** What the dashboard calls itself to an app. */
export const HOST_INFO = { name: 'agent-dashboard', version: '1.0.0' } as const;

/**
 * What a view may ask the host to do, and nothing else.
 *
 * Four, each of them something the owner can already do to the card by hand —
 * which is the test for whether an app may do it: an app is a faster way for
 * the owner to say something, never a way to reach past them.
 */
export const HOST_TOOLS = ['post_message', 'set_status', 'set_field', 'react'] as const;

export type HostTool = (typeof HOST_TOOLS)[number];

export function isHostTool(name: unknown): name is HostTool {
	return typeof name === 'string' && (HOST_TOOLS as readonly string[]).includes(name);
}

/** The showing this frame is of, as the page knows it. */
export type BridgeView = {
	id: string;
	uri: string;
	name: string;
	title: string | null;
	card: { kind: string; id: string };
	data: Record<string, unknown>;
	state: Record<string, unknown> | null;
};

export type BridgeOptions = {
	view: BridgeView;
	/** Which way round the dashboard is drawn, so an app can match it. */
	theme: () => 'light' | 'dark';
	/** The tallest the frame may grow, which the app is told up front. */
	maxHeight: number;
	locale?: string;
	/** Post one message into the frame. */
	send: (message: unknown) => void;
	/** Do one of {@link HOST_TOOLS}, as the owner, on this card. */
	call: (name: HostTool, args: Record<string, unknown>) => Promise<string>;
	/** Keep what the app saved for itself. */
	saveState: (state: Record<string, unknown> | null) => Promise<void>;
	/** The app asked to be this tall. */
	onSize: (height: number) => void;
};

export type AppBridge = {
	/** Handle one message from the frame. The caller has checked its source. */
	accept(message: unknown): Promise<void>;
	/** Push fresh data in: `set_app_data`, or a refetch that changed it. */
	data(next: Record<string, unknown>): void;
	/** The owner switched light and dark. */
	theme(next: 'light' | 'dark'): void;
	/** Whether the view has finished its handshake. */
	readonly ready: boolean;
};

type Rpc = {
	jsonrpc: '2.0';
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
};

/** JSON-RPC's own codes, used for what they mean rather than invented. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Is this shaped like a request we could answer at all? */
function asRpc(message: unknown): Rpc | undefined {
	if (!message || typeof message !== 'object') return undefined;
	const rpc = message as Rpc;
	if (rpc.jsonrpc !== '2.0') return undefined;
	if (typeof rpc.method !== 'string') return undefined;
	return rpc;
}

function params(rpc: Rpc): Record<string, unknown> {
	return rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
		? (rpc.params as Record<string, unknown>)
		: {};
}

/** The result shape the spec delivers a tool's output in. */
function toolResult(data: Record<string, unknown>) {
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		structuredContent: data,
		isError: false
	};
}

/**
 * A message as JSON, which is what `postMessage` can actually carry.
 *
 * Not belt and braces: what the host sends includes the data an agent supplied,
 * and on this page that has been through Svelte's reactive state — a `Proxy`,
 * which the structured clone algorithm refuses outright with "could not be
 * cloned". The protocol is JSON either way, so it is serialised as JSON here,
 * once, rather than every caller remembering to hand over a snapshot.
 */
function wire<Message>(message: Message): Message {
	return JSON.parse(JSON.stringify(message)) as Message;
}

export function createAppBridge(options: BridgeOptions): AppBridge {
	let ready = false;
	let data = options.view.data;
	let state = options.view.state;

	const send = (message: Record<string, unknown>) => options.send(wire(message));

	const reply = (id: string | number, result: unknown) => send({ jsonrpc: '2.0', id, result });

	const fail = (id: string | number, code: number, message: string) =>
		send({ jsonrpc: '2.0', id, error: { code, message } });

	const notify = (method: string, payload: Record<string, unknown>) => {
		// Nothing before `initialized`: the spec says so, and an app that has not
		// finished wiring its listener would miss it anyway.
		if (!ready) return;
		send({ jsonrpc: '2.0', method, params: payload });
	};

	const push = () => {
		notify('ui/notifications/tool-input', { arguments: data });
		notify('ui/notifications/tool-result', toolResult(data));
	};

	return {
		get ready() {
			return ready;
		},

		async accept(message: unknown): Promise<void> {
			const rpc = asRpc(message);
			if (!rpc) return;
			const id = rpc.id;
			const args = params(rpc);

			switch (rpc.method) {
				case 'ui/initialize': {
					if (id === undefined) return;
					reply(id, {
						protocolVersion: APP_PROTOCOL_VERSION,
						hostInfo: HOST_INFO,
						hostCapabilities: {
							// What this host actually implements, said plainly rather than
							// claimed: an app can branch on it instead of discovering a
							// method does nothing.
							tools: { list: HOST_TOOLS },
							state: {},
							size: {}
						},
						hostContext: {
							theme: options.theme(),
							locale: options.locale ?? 'en',
							containerDimensions: { maxHeight: options.maxHeight },
							// Which card this is on, because an app that shows the card's own
							// work should not have to be told twice.
							card: options.view.card,
							view: { id: options.view.id, uri: options.view.uri },
							data,
							state
						}
					});
					return;
				}

				case 'ui/notifications/initialized': {
					ready = true;
					// The data is pushed straight after the handshake as well as being in
					// `hostContext`: an app written against either one works.
					push();
					return;
				}

				case 'ui/notifications/size-changed': {
					const height = Number(args.height);
					if (Number.isFinite(height) && height > 0) options.onSize(height);
					return;
				}

				case 'ui/notifications/state-changed': {
					const next = args.state;
					if (next !== null && (typeof next !== 'object' || Array.isArray(next))) return;
					state = (next as Record<string, unknown> | null) ?? null;
					await options.saveState(state).catch(() => {
						// Swallowed: the app's scratch paper not surviving a reload is not
						// worth a banner over the feed, and the app is still working.
					});
					return;
				}

				case 'tools/call': {
					if (id === undefined) return;
					const name = args.name;
					if (!isHostTool(name)) {
						fail(
							id,
							METHOD_NOT_FOUND,
							`This host offers ${HOST_TOOLS.join(', ')}, and they act on the card this ` +
								`app is on. "${String(name)}" is not one of them.`
						);
						return;
					}

					const callArgs = args.arguments;
					if (callArgs !== undefined && (typeof callArgs !== 'object' || Array.isArray(callArgs))) {
						fail(id, INVALID_PARAMS, 'arguments must be an object');
						return;
					}

					try {
						const said = await options.call(name, (callArgs ?? {}) as Record<string, unknown>);
						reply(id, { content: [{ type: 'text', text: said }], isError: false });
					} catch (error) {
						fail(id, INTERNAL_ERROR, error instanceof Error ? error.message : 'that did not work');
					}
					return;
				}

				default: {
					// A notification we do not implement is ignored in silence, as the
					// protocol expects; a *request* is answered, so an app is never left
					// waiting on an id that will never come back.
					if (id !== undefined) fail(id, METHOD_NOT_FOUND, `no method ${rpc.method}`);
					return;
				}
			}
		},

		data(next: Record<string, unknown>): void {
			data = next;
			push();
		},

		theme(next: 'light' | 'dark'): void {
			notify('ui/notifications/theme-changed', { theme: next });
		}
	};
}

/**
 * Used by the component to refuse a message that is not from the frame it
 * rendered.
 *
 * `source` is the check that always means something. `expectOrigin` is the
 * second one, and it only exists for a hosted app (migration 042): that frame
 * has a real origin, so a message claiming to be from it must carry it. A
 * document app is on an opaque origin, where `event.origin` is the string
 * `"null"` and asserting anything about it would be theatre.
 */
export function fromFrame(
	event: { source: unknown; origin?: string },
	frame: { contentWindow: unknown },
	expectOrigin?: string
): boolean {
	if (event.source === null || event.source !== frame.contentWindow) return false;
	if (expectOrigin !== undefined && event.origin !== expectOrigin) return false;
	return true;
}
