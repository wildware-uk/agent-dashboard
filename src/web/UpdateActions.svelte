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
	 *
	 * Pinning and deleting are not here any more (migration 034). They are what
	 * every card can do, so they live in {@link CardActions} with the rest of the
	 * shared furniture, and this file is what is genuinely an update's own: the
	 * public link. Sharing rides in as that component's `extra`, so the row of
	 * buttons still reads as one row.
	 */
	import CardActions from './CardActions.svelte';
	import { actionMessage, type OwnerActions } from './actions';
	import type { UpdateView } from './types';

	let {
		update,
		actions,
		/** Whether the card is folded away right now (design §7). */
		collapsed = undefined,
		oncollapse = undefined
	}: {
		update: UpdateView;
		actions: OwnerActions;
		collapsed?: boolean;
		oncollapse?: (collapsed: boolean) => void;
	} = $props();

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
		} catch (cause) {
			// The card stays exactly as it was: a failed delete that looked like a
			// successful one would be the worst outcome available here.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

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
	<CardActions
		noun="update"
		{collapsed}
		{oncollapse}
		pinned={update.pinned}
		onpin={(pinned) => actions.pinCard('update', update.id, pinned)}
		ondelete={async () => {
			await actions.deleteUpdate(update.id);
		}}
	>
		{#snippet extra()}
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
		{/snippet}
	</CardActions>

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

	{#if error}
		<p role="alert" class="text-right text-xs text-rose-400">{error}</p>
	{/if}
</div>
