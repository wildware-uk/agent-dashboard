import { describe, expect, it } from 'vitest';
import { createAppBridge, fromFrame, HOST_TOOLS, type BridgeView } from './appbridge';

/**
 * The host half of MCP Apps (migration 041).
 *
 * What is checked here is the contract an app written for another host relies
 * on — the handshake, the notifications, the order they may arrive in — and the
 * refusals that keep a frame from reaching past the card it is on.
 */
const view: BridgeView = {
	id: 'view1',
	uri: 'ui://review-board',
	name: 'Review board',
	title: null,
	card: { kind: 'update', id: 'card1' },
	data: { open: 3 },
	state: null
};

type Sent = Record<string, unknown>;

function bridge(overrides: Partial<Parameters<typeof createAppBridge>[0]> = {}) {
	const sent: Sent[] = [];
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const saved: (Record<string, unknown> | null)[] = [];
	const sizes: number[] = [];

	const host = createAppBridge({
		view,
		theme: () => 'dark',
		maxHeight: 720,
		send: (message) => sent.push(message as Sent),
		call: async (name, args) => {
			calls.push({ name, args });
			return 'done';
		},
		saveState: async (state) => {
			saved.push(state);
		},
		onSize: (height) => sizes.push(height),
		...overrides
	});

	return { host, sent, calls, saved, sizes };
}

/** The handshake, as an app performs it. */
async function handshake(h: ReturnType<typeof bridge>) {
	await h.host.accept({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
	await h.host.accept({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
}

describe('the handshake', () => {
	it('answers ui/initialize with the host context the spec asks for', async () => {
		const h = bridge();
		await h.host.accept({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });

		const [answer] = h.sent as [{ id: number; result: Record<string, Record<string, unknown>> }];
		expect(answer.id).toBe(1);
		expect(answer.result.protocolVersion).toBe('2026-01-26');
		expect(answer.result.hostContext).toMatchObject({
			theme: 'dark',
			card: { kind: 'update', id: 'card1' },
			data: { open: 3 },
			state: null
		});
	});

	it('sends nothing to a view that has not said it is initialized', async () => {
		const h = bridge();
		h.host.data({ open: 1 });
		expect(h.sent).toEqual([]);
		expect(h.host.ready).toBe(false);
	});

	it('pushes the data straight after the handshake, so either style of app works', async () => {
		const h = bridge();
		await handshake(h);

		const methods = h.sent.map((message) => message.method).filter(Boolean);
		expect(methods).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result']);
	});
});

describe('what crosses the boundary', () => {
	it('sends JSON rather than whatever the page was holding', async () => {
		// What a card hands the bridge is Svelte state: a Proxy, which
		// `postMessage` refuses to clone. The bridge serialises, so it cannot.
		const proxied = new Proxy({ open: 3 }, {});
		const h = bridge({ view: { ...view, data: proxied } });
		await handshake(h);

		const result = h.sent.find((m) => m.method === 'ui/notifications/tool-result') as {
			params: { structuredContent: Record<string, unknown> };
		};
		expect(result.params.structuredContent).toEqual({ open: 3 });
		expect(structuredClone(h.sent[0])).toBeTruthy();
	});
});

describe('data going in', () => {
	it('redraws a running app rather than replacing the card', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		h.host.data({ open: 0 });

		const result = h.sent.find((m) => m.method === 'ui/notifications/tool-result') as {
			params: { structuredContent: Record<string, unknown> };
		};
		expect(result.params.structuredContent).toEqual({ open: 0 });
	});

	it('tells a view when the owner switches theme', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		h.host.theme('light');

		expect(h.sent).toEqual([
			{ jsonrpc: '2.0', method: 'ui/notifications/theme-changed', params: { theme: 'light' } }
		]);
	});
});

describe('what a view asks for', () => {
	it('grows the frame to the height it asked for', async () => {
		const h = bridge();
		await handshake(h);

		await h.host.accept({
			jsonrpc: '2.0',
			method: 'ui/notifications/size-changed',
			params: { width: 400, height: 320 }
		});

		expect(h.sizes).toEqual([320]);
	});

	it('keeps what it saved for itself, and refuses what is not an object', async () => {
		const h = bridge();
		await handshake(h);

		await h.host.accept({
			jsonrpc: '2.0',
			method: 'ui/notifications/state-changed',
			params: { state: { tab: 'diff' } }
		});
		await h.host.accept({
			jsonrpc: '2.0',
			method: 'ui/notifications/state-changed',
			params: { state: ['nope'] }
		});

		expect(h.saved).toEqual([{ tab: 'diff' }]);
	});

	it('performs one of the four host tools and answers the call', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		await h.host.accept({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'post_message', arguments: { body: 'Looks good.' } }
		});

		expect(h.calls).toEqual([{ name: 'post_message', args: { body: 'Looks good.' } }]);
		expect(h.sent[0]).toMatchObject({ id: 7, result: { isError: false } });
	});

	it('refuses a tool that is not one of the four, by name', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		await h.host.accept({
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: { name: 'delete_everything', arguments: {} }
		});

		const [answer] = h.sent as [{ error: { code: number; message: string } }];
		expect(answer.error.code).toBe(-32601);
		expect(answer.error.message).toContain(HOST_TOOLS[0]);
		expect(h.calls).toEqual([]);
	});

	it('answers a call that failed rather than leaving the app waiting', async () => {
		const h = bridge({
			call: async () => {
				throw new Error('that card is gone');
			}
		});
		await handshake(h);
		h.sent.length = 0;

		await h.host.accept({
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: { name: 'react', arguments: { emoji: '👍' } }
		});

		expect(h.sent[0]).toMatchObject({ id: 9, error: { message: 'that card is gone' } });
	});

	it('answers an unknown request and ignores an unknown notification', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		await h.host.accept({ jsonrpc: '2.0', id: 10, method: 'ui/whatever' });
		await h.host.accept({ jsonrpc: '2.0', method: 'ui/whatever' });

		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({ id: 10, error: { code: -32601 } });
	});

	it('ignores anything that is not JSON-RPC at all', async () => {
		const h = bridge();
		await handshake(h);
		h.sent.length = 0;

		for (const junk of [null, 'hello', 42, { method: 'tools/call' }, { jsonrpc: '1.0' }]) {
			await h.host.accept(junk);
		}

		expect(h.sent).toEqual([]);
	});
});

describe('who a message is from', () => {
	it('checks the origin too, when the frame has a real one', () => {
		const contentWindow = {};
		const at = 'https://fix.example.com';
		expect(fromFrame({ source: contentWindow, origin: at }, { contentWindow }, at)).toBe(true);
		expect(
			fromFrame({ source: contentWindow, origin: 'https://evil.example' }, { contentWindow }, at)
		).toBe(false);
		// A document app is on an opaque origin, where `origin` is the string
		// "null" and only the source is worth checking.
		expect(fromFrame({ source: contentWindow, origin: 'null' }, { contentWindow })).toBe(true);
	});

	it('accepts only the window the card rendered', () => {
		const contentWindow = {};
		expect(fromFrame({ source: contentWindow }, { contentWindow })).toBe(true);
		expect(fromFrame({ source: {} }, { contentWindow })).toBe(false);
		// An opaque origin makes `origin` useless, and a null source is every frame
		// that has gone away: neither may pass.
		expect(fromFrame({ source: null }, { contentWindow: null })).toBe(false);
	});
});

describe('the host tool list', () => {
	it('is the four things the owner could do to the card by hand', () => {
		expect([...HOST_TOOLS]).toEqual(['post_message', 'set_status', 'set_field', 'react']);
	});
});
