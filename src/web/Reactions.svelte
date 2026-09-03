<script lang="ts">
	/**
	 * The emoji on one message, and the way to add one (migration 024).
	 *
	 * The owner asked for reactions as "a nice simple way to allow quick
	 * communication", so the bar for this component is that it costs one tap and
	 * reads at a glance:
	 *
	 * - **One chip per emoji, not per reactor.** Three ticks is one chip saying
	 *   3, because what the owner wants to know is how many, and who is in the
	 *   tooltip.
	 *   Their own reaction is outlined, so "have I already reacted" needs no
	 *   counting.
	 * - **Clicking a chip toggles their own.** Same call, both directions, which
	 *   is what every other product does and therefore what a thumb expects.
	 * - **A short picker, not an emoji keyboard.** Six that mean something here:
	 *   looking, done, agree, disagree, celebrating, thinking. An agent can send
	 *   any emoji it likes and it renders fine — this is the quick path, not the
	 *   whole vocabulary.
	 *
	 * Nothing is changed optimistically. The write publishes, the tab hears it and
	 * refetches, so two windows can never disagree about what is on a message.
	 */
	import { agentLabel } from './avatar';
	import { actionMessage } from './actions';
	import type { ReactionView } from './types';

	let {
		/** The reactions on this message. Usually none. */
		reactions = [],
		/** Toggle one. Absent renders the chips read-only, with no picker. */
		onreact = undefined,
		/** Agent id to display name, for saying who reacted. */
		agentNames = {}
	}: {
		reactions?: ReactionView[];
		onreact?: (emoji: string) => Promise<void>;
		agentNames?: Record<string, string>;
	} = $props();

	/** What the picker offers: the six that carry meaning on this dashboard. */
	const QUICK = ['\u{1f440}', '✅', '\u{1f44d}', '\u{1f44e}', '\u{1f389}', '\u{1f914}'];

	let open = $state(false);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);

	/**
	 * One chip per emoji: how many, whether the owner is in it, and who.
	 *
	 * Grouped by walking the list rather than with a `Map`, which in a Svelte
	 * component is a reactivity trap (`svelte/prefer-svelte-reactivity`) — and a
	 * plain array is the right shape anyway, because the order a chip appears in
	 * is the order somebody first reacted that way.
	 */
	const chips = $derived.by(() => {
		const grouped: { emoji: string; held: ReactionView[] }[] = [];
		for (const reaction of reactions) {
			const found = grouped.find((group) => group.emoji === reaction.emoji);
			if (found) found.held.push(reaction);
			else grouped.push({ emoji: reaction.emoji, held: [reaction] });
		}

		return grouped.map(({ emoji, held }) => ({
			emoji,
			count: held.length,
			mine: held.some((reaction) => reaction.actor === 'human'),
			who: held.map((reaction) => nameOf(reaction.actor)).join(', ')
		}));
	});

	function nameOf(actor: string): string {
		if (actor === 'human') return 'You';
		const agentId = actor.startsWith('agent:') ? actor.slice('agent:'.length) : '';
		return agentLabel(agentId, agentNames[agentId]);
	}

	async function toggle(emoji: string): Promise<void> {
		if (!onreact) return;
		busy = emoji;
		error = null;
		try {
			await onreact(emoji);
			open = false;
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = null;
		}
	}
</script>

{#if chips.length > 0 || onreact}
	<div data-reactions class="flex flex-wrap items-center gap-1">
		{#each chips as chip (chip.emoji)}
			<button
				type="button"
				data-reaction={chip.emoji}
				data-mine={chip.mine ? 'true' : undefined}
				disabled={!onreact || busy !== null}
				title="{chip.who} reacted {chip.emoji}"
				aria-label="{chip.emoji} from {chip.who}"
				onclick={() => toggle(chip.emoji)}
				class="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs {chip.mine
					? 'border-accent bg-surface-raised'
					: 'border-border-subtle bg-surface'} disabled:opacity-60"
			>
				<span aria-hidden="true">{chip.emoji}</span>
				{#if chip.count > 1}
					<span class="text-content-muted tabular-nums">{chip.count}</span>
				{/if}
			</button>
		{/each}

		{#if onreact}
			{#if open}
				<div role="group" aria-label="Pick a reaction" class="flex flex-wrap items-center gap-1">
					{#each QUICK as emoji (emoji)}
						<button
							type="button"
							disabled={busy !== null}
							aria-label="React {emoji}"
							onclick={() => toggle(emoji)}
							class="rounded-full border border-border-subtle px-1.5 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-60"
						>
							{emoji}
						</button>
					{/each}
					<button
						type="button"
						aria-label="Close reactions"
						onclick={() => (open = false)}
						class="rounded px-1 text-xs text-content-muted hover:text-content"
					>
						Cancel
					</button>
				</div>
			{:else}
				<!--
					Always visible, never behind a hover: a phone cannot hover (design
					§7), and this is meant to be the cheapest control on the page.
				-->
				<button
					type="button"
					aria-label="Add a reaction"
					onclick={() => (open = true)}
					class="rounded-full border border-border-subtle px-1.5 py-0.5 text-xs text-content-muted hover:bg-surface-raised hover:text-content"
				>
					+
				</button>
			{/if}
		{/if}
	</div>

	{#if error}
		<p role="alert" class="text-xs text-rose-400">{error}</p>
	{/if}
{/if}
