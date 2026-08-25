<script lang="ts">
	/**
	 * The owner's controls on one update (design §7): pin it, or delete it.
	 *
	 * Nothing here changes what is rendered. The call goes to the server, the
	 * server publishes, and the change arrives back over the stream like any
	 * other — so this tab and every other tab reach the same state by the same
	 * route, and there is no optimistic edit that can disagree with the server.
	 *
	 * The delete is two clicks on purpose. It is the one irreversible thing the
	 * owner can do from the timeline, and the design asks for a confirmation
	 * (§7); an inline one rather than `window.confirm`, because a native dialog
	 * is untestable, unstyleable, and blocks the whole tab including the stream.
	 */
	import { actionMessage, type OwnerActions } from './actions';
	import type { UpdateView } from './types';

	let {
		update,
		actions
	}: {
		update: UpdateView;
		actions: OwnerActions;
	} = $props();

	let confirming = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

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

	const pinLabel = $derived(update.pinned ? 'Unpin update' : 'Pin update');
</script>

<div class="flex flex-col items-end gap-1" data-update-actions>
	<div class="flex items-center gap-1">
		<button
			type="button"
			disabled={busy}
			aria-label={pinLabel}
			title={pinLabel}
			aria-pressed={update.pinned}
			onclick={() => run(() => actions.setUpdatePinned(update.id, !update.pinned))}
			class="rounded p-1 text-content-muted hover:bg-surface hover:text-content disabled:opacity-50 aria-pressed:text-accent"
		>
			<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M9.5 1.5 14.5 6.5l-1.8.4-2.3 2.3.7 3.6-1.1 1.1L6.6 10 3 13.6 2 12.6l3.6-3.6L1.7 5.1l1.1-1.1 3.6.7 2.3-2.3z"
				/>
			</svg>
		</button>

		<button
			type="button"
			disabled={busy}
			aria-label="Delete update"
			title="Delete update"
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
	</div>

	{#if confirming}
		<div
			role="group"
			aria-label="Confirm delete"
			class="flex flex-wrap items-center justify-end gap-2 rounded border border-border-subtle bg-surface px-2 py-1.5 text-xs"
		>
			<span class="text-content">Delete this update?</span>
			<button
				type="button"
				disabled={busy}
				onclick={() => run(() => actions.deleteUpdate(update.id))}
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
				class="rounded border border-border-subtle px-2 py-0.5 text-content-muted hover:text-content"
			>
				Cancel
			</button>
		</div>
	{/if}

	{#if error}
		<p role="alert" class="text-right text-xs text-rose-400">{error}</p>
	{/if}
</div>
