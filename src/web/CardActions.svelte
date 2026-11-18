<script lang="ts">
	/**
	 * The owner's controls on any card (migration 034).
	 *
	 * The owner: "there are many discrepancies between the card types, they
	 * should all share the same features, and be implemented in a generic modular
	 * fashion." Pinning was written into the update card because updates were the
	 * only cards at the time, and the delete confirmation was written twice —
	 * once there and once in the thread. Neither is about a kind of card.
	 *
	 * So this is the row of controls every card shows, and each card type passes
	 * what it can actually do. What stays outside is what is genuinely one kind's
	 * own: sharing a public link belongs to updates (that is the table the share
	 * hangs off), dismissing belongs to a question. Those come in through
	 * {@link extra}, so they sit in the same row without this component knowing
	 * anything about them.
	 *
	 * Nothing here changes what is rendered. The call goes to the server, the
	 * server publishes, and the change arrives back over the stream like any
	 * other — so this tab and every other tab reach the same state by the same
	 * route, and there is no optimistic edit that can disagree with the server.
	 *
	 * The delete is two clicks on purpose. It is the irreversible one, and the
	 * design asks for a confirmation (§7): inline rather than `window.confirm`,
	 * because a native dialog is untestable, unstyleable, and blocks the whole
	 * tab including the stream.
	 */
	import { actionMessage } from './actions';
	import type { Snippet } from 'svelte';

	let {
		/** What this row is about: "post", "update", "question", "task". */
		noun,
		/**
		 * Whether the card is folded away right now (design §7).
		 *
		 * The owner: "allow me to collapse a card, which will hide the replies."
		 * Undefined hides the control, for a card there is nothing to fold.
		 */
		collapsed = undefined,
		/** Fold it, or open it again. */
		oncollapse = undefined,
		/** Whether the card is pinned right now. */
		pinned = false,
		/** Pin or unpin it. Absent hides the control. */
		onpin = undefined,
		/** Delete it, after the owner has said yes twice. Absent hides the control. */
		ondelete = undefined,
		/** What deleting takes with it, for the confirmation to say so. */
		deleteWarning = undefined,
		/** Controls only this kind of card has: share, dismiss, and so on. */
		extra = undefined
	}: {
		noun: string;
		collapsed?: boolean;
		oncollapse?: (collapsed: boolean) => void;
		pinned?: boolean;
		onpin?: (pinned: boolean) => Promise<void>;
		ondelete?: () => Promise<void>;
		deleteWarning?: string;
		extra?: Snippet;
	} = $props();

	let confirming = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const pinLabel = $derived(pinned ? `Unpin ${noun}` : `Pin ${noun}`);
	const foldLabel = $derived(collapsed ? `Expand ${noun}` : `Collapse ${noun}`);

	async function run(work: () => Promise<unknown>): Promise<void> {
		busy = true;
		error = null;
		try {
			await work();
			confirming = false;
		} catch (cause) {
			// The card stays exactly as it was: a failed delete that looked like a
			// successful one would be the worst outcome available here.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col items-end gap-1" data-card-actions>
	<div class="flex items-center gap-1">
		{#if oncollapse}
			<!--
				First in the row, because it is the one control that is about reading
				rather than about changing anything: folding a card is undoable, free,
				and the thing an owner reaches for most on a long feed.
			-->
			<button
				type="button"
				aria-label={foldLabel}
				title={foldLabel}
				aria-expanded={!collapsed}
				data-testid="collapse-card"
				onclick={() => oncollapse(!collapsed)}
				class="rounded p-1 text-content-muted hover:bg-surface hover:text-content"
			>
				<svg
					class="size-3.5 transition-transform {collapsed ? '-rotate-90' : ''}"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M8 11 2.5 5.5 3.9 4.1 8 8.2l4.1-4.1 1.4 1.4z" />
				</svg>
			</button>
		{/if}

		{#if onpin}
			<button
				type="button"
				disabled={busy}
				aria-label={pinLabel}
				title={pinLabel}
				aria-pressed={pinned}
				data-testid="pin-card"
				onclick={() => run(() => onpin(!pinned))}
				class="rounded p-1 text-content-muted hover:bg-surface hover:text-content disabled:opacity-50 aria-pressed:text-accent"
			>
				<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path
						d="M9.5 1.5 14.5 6.5l-1.8.4-2.3 2.3.7 3.6-1.1 1.1L6.6 10 3 13.6 2 12.6l3.6-3.6L1.7 5.1l1.1-1.1 3.6.7 2.3-2.3z"
					/>
				</svg>
			</button>
		{/if}

		{#if extra}{@render extra()}{/if}

		{#if ondelete}
			<button
				type="button"
				disabled={busy}
				aria-label="Delete {noun}"
				title="Delete {noun}"
				onclick={() => {
					confirming = true;
					error = null;
				}}
				class="rounded p-1 text-content-muted hover:bg-surface hover:text-rose-400 disabled:opacity-50"
			>
				<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M6 1h4l.5 1H14v2H2V2h3.5zM3 5h10l-.8 9.2a1 1 0 0 1-1 .8H4.8a1 1 0 0 1-1-.8z" />
				</svg>
			</button>
		{/if}
	</div>

	{#if confirming && ondelete}
		<div
			role="group"
			aria-label="Confirm delete"
			data-testid="confirm-delete"
			class="flex flex-wrap items-center justify-end gap-2 rounded border border-border-subtle bg-surface px-2 py-1.5 text-xs"
		>
			<span class="text-content">{deleteWarning ?? `Delete this ${noun}?`}</span>
			<button
				type="button"
				disabled={busy}
				onclick={() => run(() => ondelete())}
				class="rounded bg-rose-600 px-2 py-0.5 font-medium text-white disabled:opacity-50"
			>
				Confirm delete
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => {
					confirming = false;
					error = null;
				}}
				class="rounded border border-border-subtle px-2 py-0.5 text-content-muted hover:text-content disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	{/if}

	{#if error}
		<p role="alert" class="text-right text-xs text-rose-400">{error}</p>
	{/if}
</div>
