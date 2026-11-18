<script lang="ts">
	/**
	 * One app, running on a card (migration 041).
	 *
	 * The owner: "I want apps to be able to embed UI directly into the dashboard."
	 * This is the host end of MCP Apps: the frame, the handshake, and the four
	 * things an app is allowed to ask the dashboard to do.
	 *
	 * ## The sandbox is the whole security story, and it differs by kind
	 *
	 * A **document app** (migration 041) is markup an agent wrote, so it is framed
	 * with `sandbox="allow-scripts"` and **no** `allow-same-origin`. Those two
	 * facts together put it on an opaque origin: it cannot read the session
	 * cookie, cannot touch this page's DOM, cannot navigate it, and has no
	 * storage. Its `src` is `/apps/:view`, which answers with a
	 * Content-Security-Policy built from the origins the agent declared when it
	 * registered — nothing else is reachable (`src/http/apps/serve.ts`).
	 *
	 * A **hosted app** (migration 042) is a page some service already serves, and
	 * it is framed with `allow-same-origin` as well. That is not a relaxation of
	 * the boundary: "same origin" there means *the service's* origin, not this
	 * dashboard's, and the page is cross-origin from this session either way. What
	 * it buys is the service's own cookies — which is the entire reason to point
	 * at a service rather than ship a document.
	 *
	 * Neither may navigate the page it sits in: `allow-top-navigation` is withheld
	 * from both, so a framed page cannot move the owner off the dashboard.
	 *
	 * ## Who a message is from
	 *
	 * For a document app the origin is opaque, so `event.origin` is the string
	 * `"null"` and is worth nothing; the check that means something is
	 * `event.source === frame.contentWindow`. For a hosted app the origin is real,
	 * so it is checked as well — a page is heard only from the origin it was
	 * framed from. Both happen here, before a byte reaches the bridge.
	 *
	 * ## Height
	 *
	 * The app asks, through `ui/notifications/size-changed`, and is given what it
	 * asked for up to {@link MAX_HEIGHT}. A frame that could size itself without a
	 * ceiling would let one card push the rest of the feed off the screen.
	 *
	 * ## Off until it is asked for
	 *
	 * A card is opened with its app collapsed to a header line naming it and the
	 * agent that shipped it. An app is somebody else's code, and running four of
	 * them because the owner scrolled past four cards is not what scrolling past
	 * means. Pressing the line runs it.
	 */
	import { onMount } from 'svelte';
	import {
		createAppBridge,
		fromFrame,
		type AppBridge,
		type BridgeView,
		type HostTool
	} from './appbridge';
	import type { CardKind, OwnerActions } from './actions';
	import type { AppView } from './types';

	let {
		app,
		/**
		 * The owner's own write calls. A `tools/call` from the frame goes through
		 * these, which is what makes it the owner acting rather than the agent:
		 * the same endpoints, the same session, the same events. Absent on a
		 * read-only page — a share link — where the frame still runs and anything
		 * it calls is refused.
		 */
		actions
	}: {
		app: AppView;
		actions?: OwnerActions;
	} = $props();

	/** The tallest an app may make itself. A card, not a page. */
	const MAX_HEIGHT = 720;

	/** What it starts at before it has asked, so a slow app is not a sliver. */
	const START_HEIGHT = 180;

	let frame = $state<HTMLIFrameElement | null>(null);
	let open = $state(false);
	let height = $state(START_HEIGHT);
	let bridge: AppBridge | null = null;

	const card = $derived(app.card as { kind: CardKind; id: string });

	/** A page a service serves, or the document this deployment serves for it. */
	const source = $derived(app.url ?? `/apps/${app.id}`);

	/**
	 * What the frame is allowed to do.
	 *
	 * `allow-same-origin` only for a hosted app, and only ever meaning the
	 * service's own origin. Never for markup an agent wrote.
	 */
	const sandbox = $derived(
		app.url ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts'
	);

	/** The origin a hosted app's messages must come from, if it is one. */
	const expectOrigin = $derived.by(() => {
		if (!app.url) return undefined;
		try {
			return new URL(app.url).origin;
		} catch {
			return undefined;
		}
	});

	/** The showing as the bridge wants it. */
	function viewOf(): BridgeView {
		return {
			id: app.id,
			uri: app.uri,
			name: app.name,
			title: app.title,
			card: app.card,
			data: app.data ?? {},
			state: app.state ?? null
		};
	}

	function theme(): 'light' | 'dark' {
		return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	}

	/** Which anchor a reply to this card hangs off. */
	function anchor(body: string) {
		if (card.kind === 'message') return { replyTo: card.id, body };
		if (card.kind === 'request') return { request: card.id, body };
		return { update: card.id, body };
	}

	async function call(name: HostTool, args: Record<string, unknown>): Promise<string> {
		if (!actions) throw new Error('this page is read-only');

		if (name === 'post_message') {
			const body = String(args.body ?? '').trim();
			if (body === '') throw new Error('body is required');
			await actions.postMessage(anchor(body));
			return 'Posted.';
		}
		if (name === 'set_status') {
			const status = args.status === null ? null : String(args.status ?? '');
			await actions.setCardStatus(card.kind, card.id, status);
			return status === null ? 'Cleared the status.' : `Marked ${status}.`;
		}
		if (name === 'set_field') {
			const field = String(args.name ?? '').trim();
			if (field === '') throw new Error('name is required');
			const value = args.value === null ? null : String(args.value ?? '');
			await actions.setCardField(card.kind, card.id, field, value);
			return value === null ? `Removed ${field}.` : `Set ${field}.`;
		}
		const emoji = String(args.emoji ?? '').trim();
		if (emoji === '') throw new Error('emoji is required');
		await actions.reactToCard(card.kind, card.id, emoji);
		return 'Reacted.';
	}

	onMount(() => {
		function onMessage(event: MessageEvent): void {
			// The identity check: an opaque origin makes `event.origin` useless, so
			// what counts is that this is the window we rendered.
			if (!frame || !fromFrame(event, frame, expectOrigin)) return;
			void bridge?.accept(event.data);
		}

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});

	/** Build the bridge once the frame exists, and rebuild it if the app changes. */
	$effect(() => {
		const element = frame;
		if (!open || !element) {
			bridge = null;
			return;
		}

		bridge = createAppBridge({
			view: viewOf(),
			theme,
			maxHeight: MAX_HEIGHT,
			send: (message) => element.contentWindow?.postMessage(message, '*'),
			call,
			saveState: async (state) => {
				await actions?.saveAppState(app.id, state);
			},
			onSize: (asked) => {
				height = Math.min(Math.max(Math.round(asked), 80), MAX_HEIGHT);
			}
		});
	});

	/**
	 * Fresh data reaches a running app without reloading it.
	 *
	 * This is what `set_app_data` is for: the agent pushes the next build into the
	 * board and the frame redraws, rather than the card being replaced under the
	 * owner's hands.
	 */
	$effect(() => {
		const data = app.data ?? {};
		bridge?.data(data);
	});
</script>

<div data-app-frame data-app-uri={app.uri} class="flex flex-col gap-1">
	<button
		type="button"
		onclick={() => (open = !open)}
		aria-expanded={open}
		class="flex items-center gap-2 self-start rounded border border-border-subtle px-2 py-1 text-xs text-content-muted hover:text-content"
	>
		<span aria-hidden="true">{open ? '▾' : '▸'}</span>
		<span>{app.title ?? app.name}</span>
		{#if !open}
			<span class="text-content-muted">— an app, press to run it</span>
		{/if}
	</button>

	{#if open}
		<!--
			`sandbox` is doing the work here. For a document an agent wrote it is
			`allow-scripts` alone, so the markup runs on an opaque origin with no
			reach into this page at all — never add `allow-same-origin` to that case,
			it would hand an agent's markup the owner's session. A hosted page gets
			`allow-same-origin` because the origin it then has is the service's own.
		-->
		<iframe
			bind:this={frame}
			src={source}
			title={app.name}
			{sandbox}
			referrerpolicy="no-referrer"
			loading="lazy"
			style="height: {height}px"
			class="w-full rounded border border-border-subtle bg-surface"
		></iframe>

		{#if app.url}
			<!--
				Where this came from, said out loud. A frame showing somebody else's
				service should never be mistaken for part of the dashboard.
			-->
			<p class="text-xs text-content-muted">Served by {expectOrigin}</p>
		{/if}

		{#if app.description}
			<p class="text-xs text-content-muted">{app.description}</p>
		{/if}
	{/if}
</div>
