<script lang="ts">
	/**
	 * Choosing a project's words (migration 039).
	 *
	 * The owner: "let me set tags on a post before I actually post it… and let me
	 * set colours for tags, like trello."
	 *
	 * One panel, used in two places — on a card, where choosing writes straight
	 * through, and in the composer, where the choice is held until the post
	 * exists. It takes a set of chosen ids and callbacks rather than a card,
	 * which is what lets the draft case work at all: a post that has not been
	 * written yet has no id to hang a tag on.
	 *
	 * Colours are Trello's model, which is the one people already know: a row of
	 * swatches, picked on the word rather than on the card, so recolouring "bug"
	 * recolours it everywhere at once.
	 */
	import { dismissable } from './dismiss';
	import { TAG_COLOURS, tagLook } from './tags';
	import type { TagView } from './types';

	let {
		/** The project's vocabulary. */
		tags = [],
		/** Which of them are chosen right now. */
		chosen = new Set<string>(),
		/** Put one on, or take it off. */
		ontoggle,
		/** Decide a new word — with a colour, chosen before it is created. */
		oncreate,
		/** Repaint an existing word, everywhere it is worn. */
		onrecolour,
		/** Close the panel: something was done in it, or the reader pressed away. */
		onclose,
		/**
		 * The button that opened this, so pressing it again still closes it.
		 *
		 * Without it the press would close the panel and the button's own click
		 * would reopen it, which reads as the button having done nothing.
		 */
		trigger = null
	}: {
		tags?: TagView[];
		chosen?: Set<string>;
		ontoggle?: (tagId: string, on: boolean) => Promise<void> | void;
		oncreate?: (name: string, colour: string) => Promise<void> | void;
		onrecolour?: (tagId: string, colour: string) => Promise<void> | void;
		onclose?: () => void;
		trigger?: HTMLElement | null;
	} = $props();

	let typed = $state('');
	let colour = $state('grey');
	let busy = $state(false);
	/** Which word's swatches are open, or `null` while none are. */
	let painting = $state<string | null>(null);

	async function run(work: () => Promise<void> | void): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await work();
		} catch {
			// Swallowed on purpose: the chip not changing is the whole failure, and
			// a banner over the feed for a label is louder than what it reports.
		} finally {
			busy = false;
		}
	}
</script>

<div
	use:dismissable={{ onclose: () => onclose?.(), ignore: trigger }}
	data-testid="tag-picker"
	class="absolute top-full left-0 z-20 mt-1 flex w-60 flex-col gap-1 rounded-md border border-border-subtle bg-surface-raised p-2 shadow-lg"
>
	{#each tags as tag (tag.id)}
		<div class="flex flex-col gap-1">
			<div class="flex items-center gap-1">
				<button
					type="button"
					disabled={busy}
					data-pick={tag.id}
					aria-pressed={chosen.has(tag.id)}
					onclick={() => run(() => ontoggle?.(tag.id, !chosen.has(tag.id)))}
					class="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-surface disabled:opacity-50"
				>
					<span
						class="truncate rounded-full border px-2 py-0.5 text-[0.7rem] font-medium {tagLook(
							tag.colour
						)}">{tag.name}</span
					>
					{#if chosen.has(tag.id)}
						<span aria-hidden="true" class="text-accent">✓</span>
					{/if}
				</button>

				{#if onrecolour}
					<!--
						The colour belongs to the word, not to this card: repainting "bug"
						repaints every card wearing it, which is the point of the project
						deciding its own vocabulary.
					-->
					<button
						type="button"
						aria-label="Colour for {tag.name}"
						aria-expanded={painting === tag.id}
						data-paint={tag.id}
						onclick={() => (painting = painting === tag.id ? null : tag.id)}
						class="shrink-0 rounded border border-border-subtle px-1.5 py-1 text-[0.7rem] text-content-muted hover:text-content"
					>
						●
					</button>
				{/if}
			</div>

			{#if painting === tag.id && onrecolour}
				<div class="flex flex-wrap gap-1 px-1.5 pb-1" data-testid="tag-swatches">
					{#each TAG_COLOURS as option (option)}
						<button
							type="button"
							disabled={busy}
							aria-label={option}
							aria-pressed={(tag.colour ?? 'grey') === option}
							data-swatch={option}
							onclick={() =>
								run(async () => {
									await onrecolour(tag.id, option);
									painting = null;
								})}
							class="size-5 rounded border {tagLook(option)} disabled:opacity-50"
						></button>
					{/each}
				</div>
			{/if}
		</div>
	{/each}

	{#if tags.length === 0}
		<p class="px-1.5 py-1 text-xs text-content-muted">
			This project has no tags yet. Type one below.
		</p>
	{/if}

	{#if oncreate}
		<form
			class="flex flex-col gap-1 border-t border-border-subtle pt-1.5"
			onsubmit={(event) => {
				event.preventDefault();
				const name = typed.trim();
				if (name === '') return;
				void run(async () => {
					await oncreate(name, colour);
					typed = '';
					colour = 'grey';
					onclose?.();
				});
			}}
		>
			<div class="flex items-center gap-1">
				<input
					bind:value={typed}
					maxlength="32"
					placeholder="New tag…"
					aria-label="New tag"
					data-testid="tag-new"
					class="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-1 text-xs text-content"
				/>
				<button
					type="submit"
					disabled={busy || typed.trim() === ''}
					class="rounded bg-accent px-2 py-1 text-xs font-medium text-surface disabled:opacity-50"
				>
					Add
				</button>
			</div>

			<!-- The colour is chosen before the word exists, as it is on a Trello label. -->
			<div class="flex flex-wrap gap-1" data-testid="tag-new-colours">
				{#each TAG_COLOURS as option (option)}
					<button
						type="button"
						aria-label={option}
						aria-pressed={colour === option}
						data-new-colour={option}
						onclick={() => (colour = option)}
						class="size-5 rounded border {tagLook(option)} {colour === option
							? 'ring-2 ring-accent'
							: ''}"
					></button>
				{/each}
			</div>
		</form>
	{/if}
</div>
