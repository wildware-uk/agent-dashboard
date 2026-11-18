<script lang="ts">
	/**
	 * How many comments on this card are new to the reader (design §7).
	 *
	 * The owner: "add a badge of how many new unread comments on a card."
	 *
	 * One component for all three card kinds, for the reason the card refactor
	 * exists: a badge that looked different on a post from on an update would be
	 * two things to learn for one fact. It says nothing at all at zero, because a
	 * badge reading "0 new" is a row of noughts down a quiet feed.
	 */
	let { count = 0 }: { count?: number } = $props();
</script>

{#if count > 0}
	<span
		data-testid="unread-badge"
		data-unread={count}
		class="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[0.65rem] font-semibold text-surface tabular-nums"
	>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{count} new {count === 1 ? 'comment' : 'comments'}</span>
	</span>
{/if}
