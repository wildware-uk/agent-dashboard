<script lang="ts">
	/**
	 * The words on a card, and the one click that adds another (migration 039).
	 *
	 * The owner: "allow users and agents to define tags for a project, ie
	 * 'feature, bug, high priority' etc, and these can be included on feed posts
	 * by agents and users in one click."
	 *
	 * So the picker is the project's list, already decided, and choosing one is a
	 * single press — no dialog, no form, no navigating to a settings page. Typing
	 * is only for the word that does not exist yet, which is the rarer act and the
	 * one that deserves the extra keystrokes.
	 *
	 * One component for every card kind, like the status chip and the unread
	 * badge: a label that looked different on a post from on an update would be
	 * two things to learn for one fact.
	 */
	import TagPicker from './TagPicker.svelte';
	import { tagLook, tagsFor, tagsOn } from './tags';
	import type { CardTagView, TagView } from './types';

	let {
		card,
		projectId = null,
		/** Every word the projects on this page know. */
		tags = [],
		/** Where those words are worn, across every card on this page. */
		worn = [],
		/** Put one on, or take it off. Absent renders the chips read-only. */
		ontag,
		/** Decide a new word for this project, and put it straight on the card. */
		oncreate,
		/** Repaint a word, everywhere it is worn (the owner: "like trello"). */
		onrecolour
	}: {
		card: { kind: string; id: string };
		projectId?: string | null;
		tags?: TagView[];
		worn?: CardTagView[];
		ontag?: (tagId: string, on: boolean) => Promise<void> | void;
		oncreate?: (name: string, colour: string) => Promise<void> | void;
		onrecolour?: (tagId: string, colour: string) => Promise<void> | void;
	} = $props();

	const mine = $derived(tagsOn(card, worn, tags));
	const available = $derived(tagsFor(projectId, tags));
	const wearing = $derived(new Set(mine.map((tag) => tag.id)));

	let open = $state(false);
	/** The button that opens the picker, so pressing it again closes it. */
	let trigger = $state<HTMLElement | null>(null);
	let busy = $state(false);

	async function toggle(tagId: string, on: boolean): Promise<void> {
		if (!ontag || busy) return;
		busy = true;
		try {
			await ontag(tagId, on);
		} catch {
			// Swallowed: the chip not changing is the whole failure, and an error
			// banner over the feed for a label is louder than the thing it reports.
		} finally {
			busy = false;
		}
	}
</script>

{#if mine.length > 0 || ontag}
	<div class="flex min-w-0 flex-wrap items-center gap-1" data-testid="tag-chips">
		{#each mine as tag (tag.id)}
			{#if ontag}
				<button
					type="button"
					disabled={busy}
					data-tag={tag.id}
					aria-label="Remove the tag {tag.name}"
					onclick={() => toggle(tag.id, false)}
					class="rounded-full border px-2 py-0.5 text-[0.7rem] font-medium disabled:opacity-50 {tagLook(
						tag.colour
					)}"
				>
					{tag.name}
				</button>
			{:else}
				<!-- Read-only: a shared card has no owner behind it to write with. -->
				<span
					data-tag={tag.id}
					class="rounded-full border px-2 py-0.5 text-[0.7rem] font-medium {tagLook(tag.colour)}"
				>
					{tag.name}
				</span>
			{/if}
		{/each}

		{#if ontag}
			<div class="relative">
				<!--
					A rounded square rather than another pill (the owner asked for it):
					the chips are the words, and the control that opens the list should
					not read as one more of them.
				-->
				<button
					bind:this={trigger}
					type="button"
					aria-expanded={open}
					aria-label="Add a tag"
					data-testid="tag-add"
					onclick={() => (open = !open)}
					class="flex size-5 items-center justify-center rounded border border-border-subtle text-xs leading-none text-content-muted hover:border-accent hover:text-content"
				>
					<span aria-hidden="true">+</span>
				</button>

				{#if open}
					<TagPicker
						tags={available}
						chosen={wearing}
						ontoggle={toggle}
						oncreate={oncreate
							? async (name, colour) => {
									await oncreate(name, colour);
									open = false;
								}
							: undefined}
						{onrecolour}
						{trigger}
						onclose={() => (open = false)}
					/>
				{/if}
			</div>
		{/if}
	</div>
{/if}
