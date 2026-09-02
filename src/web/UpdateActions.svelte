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
	 *
	 * Share is the other control that needs care, for the opposite reason: it is
	 * the one thing here that makes something readable without a session (§8).
	 * Two things follow. **The URL is shown once**, because the server keeps only
	 * an HMAC of the token and cannot produce it again — so this component holds
	 * it in local state after minting it, and re-sharing mints a new link and
	 * retires the old. And **a shared card says so**, permanently, on the card
	 * itself: the owner has to be able to see at a glance which of their timeline
	 * is public without clicking anything.
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

	/**
	 * The link, from the moment it was minted until this card unmounts.
	 *
	 * Deliberately not read back from anywhere: nothing can produce it a second
	 * time. If the owner loses it, the answer is to share again, which is also
	 * the only way to invalidate a URL somebody has already pasted somewhere.
	 */
	let link = $state<string | null>(null);
	let copied = $state(false);

	const shared = $derived(update.share !== undefined);

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
	const shareLabel = $derived(shared ? 'Sharing options' : 'Share a public link');

	async function share(): Promise<void> {
		await run(async () => {
			const { url } = await actions.shareUpdate(update.id);
			link = url;
			copied = false;
		});
	}

	async function revoke(): Promise<void> {
		await run(async () => {
			await actions.revokeShare(update.id);
			link = null;
		});
	}

	/**
	 * Copy, and say so.
	 *
	 * The clipboard API is not available on an insecure origin or in every
	 * browser, so a failure leaves the URL on screen to be selected by hand
	 * rather than reporting an error the owner can do nothing about.
	 */
	async function copy(): Promise<void> {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
		} catch {
			copied = false;
		}
	}
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
			aria-label={shareLabel}
			title={shareLabel}
			aria-pressed={shared}
			data-testid="share-update"
			onclick={() => void share()}
			class="rounded p-1 text-content-muted hover:bg-surface hover:text-content disabled:opacity-50 aria-pressed:text-accent"
		>
			<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M11 1a2.5 2.5 0 1 0-2.45 3L5.9 6.1a2.5 2.5 0 1 0 0 3.8l2.65 2.1A2.5 2.5 0 1 0 9.4 10.9L6.75 8.8a2.5 2.5 0 0 0 0-1.6L9.4 5.1A2.5 2.5 0 0 0 11 1"
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

	{#if link}
		<div
			role="group"
			aria-label="Share link"
			data-testid="share-link"
			class="flex max-w-full flex-wrap items-center justify-end gap-2 rounded border border-accent/40 bg-surface px-2 py-1.5 text-xs"
		>
			<!--
				Selectable, and shown in full. This is the only time this URL exists
				outside the holder's browser, so a truncated copy the owner cannot
				select by hand would be a link they have to mint again to read.
			-->
			<input
				readonly
				value={link}
				aria-label="Public link to this update"
				onfocus={(event) => event.currentTarget.select()}
				class="min-w-0 flex-1 rounded border border-border-subtle bg-surface-sunken px-1.5 py-0.5 text-content"
			/>
			<button
				type="button"
				onclick={() => void copy()}
				class="rounded bg-accent px-2 py-0.5 font-medium text-surface"
			>
				{copied ? 'Copied' : 'Copy'}
			</button>
			<button
				type="button"
				disabled={busy}
				onclick={() => void revoke()}
				class="rounded border border-border-subtle px-2 py-0.5 text-content-muted hover:text-content"
			>
				Stop sharing
			</button>
			<p class="w-full text-right text-content-muted">
				Anyone with this link can read this card. It is shown once — sharing again replaces it.
			</p>
		</div>
	{:else if shared}
		<div
			class="flex flex-wrap items-center justify-end gap-2 text-xs text-content-muted"
			data-testid="share-state"
		>
			<span>
				Public · {update.share?.views ?? 0}
				{(update.share?.views ?? 0) === 1 ? 'view' : 'views'}
			</span>
			<button
				type="button"
				disabled={busy}
				onclick={() => void revoke()}
				class="rounded border border-border-subtle px-2 py-0.5 hover:text-content"
			>
				Stop sharing
			</button>
		</div>
	{/if}

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
