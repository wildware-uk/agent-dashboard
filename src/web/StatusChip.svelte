<script lang="ts">
	/**
	 * A card's work state, and the way to change it (migration 035).
	 *
	 * The owner: "instead agents can mark a card in the feed as a task, and update
	 * the status of the card." The board's columns are this chip: one control, on
	 * the card, that says where the work has got to and moves it.
	 *
	 * A card nobody has marked shows nothing until the owner asks for it, which is
	 * what keeps an ordinary feed looking like a feed — the "Mark as work" button
	 * only appears on hover or focus, and the chip is always there once it is one.
	 *
	 * Nothing changes here optimistically. The call goes to the server, the server
	 * publishes, the tab refetches: two windows can never disagree about what is
	 * being worked on.
	 */
	import { actionMessage } from './actions';
	import { STATUSES, statusLook, type CardStatus } from './status';

	let {
		/** The state right now, or `null` for a card nobody has marked as work. */
		status = null,
		/** Change it. Absent renders the chip read-only, with no menu. */
		onstatus = undefined
	}: {
		status?: string | null;
		onstatus?: (status: CardStatus | null) => Promise<void>;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const look = $derived(statusLook(status));

	async function choose(next: CardStatus | null): Promise<void> {
		if (!onstatus) return;
		busy = true;
		error = null;
		try {
			await onstatus(next);
			open = false;
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

<div class="relative flex min-w-0 items-center gap-1.5" data-status={status ?? undefined}>
	{#if look}
		<button
			type="button"
			disabled={busy || !onstatus}
			aria-label="Work state: {look.label}"
			data-testid="status-chip"
			onclick={() => (open = !open)}
			class="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase disabled:opacity-100 {look.chip}"
		>
			{look.label}
		</button>
	{:else if onstatus}
		<!--
			Quiet until it is wanted: an ordinary card is not work, and a feed where
			every card advertised a state nobody set would read as a board.
		-->
		<button
			type="button"
			disabled={busy}
			data-testid="mark-work"
			onclick={() => (open = !open)}
			class="rounded px-1.5 py-0.5 text-[0.65rem] font-medium text-content-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
		>
			Mark as work
		</button>
	{/if}

	{#if open && onstatus}
		<div
			role="group"
			aria-label="Set the work state"
			data-testid="status-menu"
			class="absolute top-full right-0 z-10 mt-1 flex w-40 flex-col rounded-md border border-border-subtle bg-surface-raised p-1 shadow-lg"
		>
			{#each STATUSES as option (option)}
				{@const each = statusLook(option)!}
				<button
					type="button"
					disabled={busy}
					aria-pressed={status === option}
					onclick={() => void choose(option)}
					class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-content hover:bg-surface disabled:opacity-50"
				>
					<span class="size-2 shrink-0 rounded-full {each.chip}"></span>
					{each.label}
				</button>
			{/each}
			{#if look}
				<button
					type="button"
					disabled={busy}
					data-testid="unmark-work"
					onclick={() => void choose(null)}
					class="mt-1 rounded border-t border-border-subtle px-2 py-1.5 text-left text-xs text-content-muted hover:text-content disabled:opacity-50"
				>
					Not work
				</button>
			{/if}
		</div>
	{/if}

	{#if error}
		<p role="alert" class="text-xs text-rose-400">{error}</p>
	{/if}
</div>
