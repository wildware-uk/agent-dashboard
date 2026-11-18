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
	 * - **thinking** — an animated "… is thinking…". A claim about *now*, which is
	 *   why it is rendered only while that agent is online **and only while the
	 *   claim is still plausibly about now**. An animation still running against
	 *   an agent that died an hour ago is worse than nothing: it is a lie the
	 *   owner has no way to check, and it is exactly the silence this feature
	 *   exists to end.
	 *
	 * The owner's report was that it "seems to hang around on posts too long", and
	 * being online was not enough to stop it. The reason is that presence is per
	 * *agent* and a claim to be thinking is per *session*: several sessions share
	 * one bearer token here, so while any of them is beating, every abandoned
	 * "thinking" any of them ever left is still animating — hours later, on posts
	 * nobody is working on.
	 *
	 * So a claim also expires, at `THINKING_MAX_AGE_MS` (`./acks.ts`). The number
	 * is not
	 * arbitrary: it is the same idle window after which the server closes a silent
	 * session (`SESSION_IDLE_MS`). The platform has already decided that an agent
	 * silent that long is gone, and this agrees with it rather than animating on.
	 * An agent genuinely still working re-asserts `thinking` — the tool says
	 * plainly that it is safe to send twice — and a missing animation is in any
	 * case a smaller wrong than a false one.
	 *
	 * Presence and the clock are passed in rather than read from stores, so the
	 * component is the same object in a spec as it is on the page — and so the
	 * decision about what "online" means stays in the one place that already
	 * derives it (`presence.svelte.ts`).
	 */
	import { agentLabel } from './avatar';
	import { absoluteLabel } from './days';
	import { isUndelivered, thinkingIsCurrent } from './acks';
	import type { AckView, DeliveryView } from './types';

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
		onlineIds = [],
		/**
		 * Which agents this message has actually reached (migration 018).
		 *
		 * The state before anybody says anything: the server pushed it onto that
		 * agent's live stream. Shown only while the agent has said nothing —
		 * "read", "thinking" and "done" all imply it arrived, and two lines saying
		 * the same thing is one line too many.
		 */
		deliveries = [],
		/**
		 * The instant to judge a "thinking" claim against.
		 *
		 * Passed in so a card that is already ticking for its relative timestamps
		 * makes the animation stop on its own, and so a spec can hand over a fixed
		 * time instead of waiting the window out for one.
		 */
		now = Date.now(),
		/**
		 * The message this is about, when it is one that ought to reach an agent.
		 *
		 * The owner: "when a message isn't delivered yet, hold a red icon saying it
		 * wasn't delivered to an agent." Given one, a card that nothing has
		 * received says so in red once delivery has had time to happen. Absent —
		 * which is every card that is not the owner writing to agents — nothing is
		 * claimed either way, because "nobody received it" is not a sentence about
		 * an agent's own update.
		 */
		expects = undefined
	}: {
		acks?: AckView[];
		agentNames?: Record<string, string>;
		onlineIds?: string[];
		deliveries?: DeliveryView[];
		now?: number;
		expects?: { createdAt: number };
	} = $props();

	const shown = $derived(
		acks.filter(
			(ack) =>
				ack.state !== 'thinking' || (onlineIds.includes(ack.agentId) && thinkingIsCurrent(ack, now))
		)
	);

	/** Delivered, and nothing said about it yet: the agent that has it, silently. */
	const silent = $derived(
		deliveries.filter((delivery) => !acks.some((ack) => ack.agentId === delivery.agentId))
	);

	const nameOf = (agentId: string) => agentLabel(agentId, agentNames[agentId]);

	/** Nothing has it, and enough time has passed to say so (`./acks.ts`). */
	const undelivered = $derived(
		expects !== undefined && isUndelivered(expects, acks, deliveries, now)
	);
</script>

{#if shown.length > 0 || silent.length > 0 || undelivered}
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
					<span data-ack-thinking class="flex items-center gap-2 text-content-muted">
						{nameOf(ack.agentId)} is thinking
						<!--
							A bar sweeping beside it, and nothing else. There were three
							blinking dots here too until the owner saw both at once: "I do like
							it, remove the dots, in favour of the loading bar." They were saying
							the same thing twice in the same line, and the bar says it better —
							indeterminate on purpose, because nobody knows how far through a
							thought an agent is.
						-->
						<span class="thinking-bar h-1 w-10" data-testid="thinking-bar" aria-hidden="true"
						></span>
					</span>
				{/if}
			</li>
		{/each}

		{#if undelivered}
			<li class="flex items-center gap-1">
				<!--
					Red, and a warning triangle rather than a plane: the plane family is
					what happened *to* the message, and this is the case where nothing
					did. It is the loudest thing this component says, because it is the
					only one the owner has to act on — nobody is listening.
				-->
				<svg
					data-ack-undelivered
					class="size-3.5 shrink-0 text-rose-500"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M8 1.5a1 1 0 0 1 .87.5l6 10.5A1 1 0 0 1 14 14H2a1 1 0 0 1-.87-1.5l6-10.5A1 1 0 0 1 8 1.5m0 3.75a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.25M8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2"
					/>
				</svg>
				<span class="font-medium text-rose-500">Not delivered to any agent</span>
			</li>
		{/if}

		{#each silent as delivery (delivery.id)}
			<li class="flex items-center gap-1">
				<!--
					A paper-plane rather than a tick: the tick family belongs to what the
					agent said, and this is what the server did. The distinction matters
					on a silent card — "we handed it over" is not "somebody read it".
				-->
				<svg
					data-ack-delivered
					class="size-3 shrink-0 text-content-muted"
					viewBox="0 0 16 16"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M1.5 7.5 14.5 2l-4 12-2.6-4.4z" />
				</svg>
				<span class="text-content-muted" title={absoluteLabel(delivery.deliveredAt)}>
					delivered to {nameOf(delivery.agentId)}
				</span>
			</li>
		{/each}
	</ul>
{/if}
