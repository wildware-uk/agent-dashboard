<script lang="ts">
	/**
	 * What an agent has said about one message or task, without words
	 * (migration 013).
	 *
	 * Three things, each of which decodes at a glance:
	 *
	 * - **done** — a tick. A fact about the past, so it stays whether or not the
	 *   agent that left it is still running.
	 * - **read** — a hollow tick. Also a fact about the past, and the smallest
	 *   honest thing an agent can say. It exists because agents would not say
	 *   `done` about a message and so said nothing at all.
	 * - **thinking** — an animated "… is thinking…". A claim about *now*, which
	 *   is why it is rendered only while that agent is online. An animation still
	 *   running against an agent that died an hour ago is worse than nothing: it
	 *   is a lie the owner has no way to check, and it is exactly the silence
	 *   this feature exists to end.
	 *
	 * Presence is passed in rather than read from a store, so the component is
	 * the same object in a spec as it is on the page — and so the decision about
	 * what "online" means stays in the one place that already derives it
	 * (`presence.svelte.ts`).
	 */
	import { agentLabel } from './avatar';
	import type { AckView } from './types';

	let {
		/** Every acknowledgement on this one thing. Usually none or one. */
		acks = [],
		/** Agent id to display name, as the shell resolves it for the cards. */
		agentNames = {},
		/**
		 * Ids of the agents beating right now.
		 *
		 * Empty means nobody is online, which is the honest default for a
		 * component rendered without presence: `done` and `read` still show,
		 * `thinking` does not.
		 */
		onlineIds = []
	}: {
		acks?: AckView[];
		agentNames?: Record<string, string>;
		onlineIds?: string[];
	} = $props();

	const shown = $derived(
		acks.filter((ack) => ack.state !== 'thinking' || onlineIds.includes(ack.agentId))
	);

	const nameOf = (agentId: string) => agentLabel(agentId, agentNames[agentId]);
</script>

{#if shown.length > 0}
	<ul data-ack class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
		{#each shown as ack (ack.id)}
			<li class="flex items-center gap-1">
				{#if ack.state === 'done'}
					<!--
						The tick is decorative: the sentence beside it carries the meaning,
						so a screen reader is not asked to describe a path.
					-->
					<svg
						data-ack-done
						class="size-3.5 shrink-0 text-emerald-400"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="2.25"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M3 8.5l3.5 3.5L13 4.5" />
					</svg>
					<span class="text-content-muted">{nameOf(ack.agentId)} marked this done</span>
				{:else if ack.state === 'read'}
					<!--
						A hollow tick against the solid one: the same shape, so the two read
						as steps of one thing rather than as two unrelated badges, and a
						muted colour because "seen it" is smaller news than "finished".
					-->
					<svg
						data-ack-read
						class="size-3.5 shrink-0 text-content-muted"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M3 8.5l3.5 3.5L13 4.5" />
					</svg>
					<span class="text-content-muted">{nameOf(ack.agentId)} has read this</span>
				{:else}
					<span data-ack-thinking class="flex items-center gap-1 text-content-muted">
						{nameOf(ack.agentId)} is thinking<!--
							Three spans rather than an animated string, so the dots can be
							staggered and so `prefers-reduced-motion` can stop them without
							the sentence losing its ellipsis.
						--><span
							class="thinking-dots"
							aria-hidden="true"><span>.</span><span>.</span><span>.</span></span
						>
					</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
