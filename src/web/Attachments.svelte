<script lang="ts">
	/**
	 * The files going out with a message (migration 016, migration 026).
	 *
	 * Three ways in, because they are three different habits and a picker that
	 * answers only one of them is a picker people work around:
	 *
	 * - the **file chooser**, for the file you know the name of;
	 * - **paste**, which is how a screenshot actually arrives;
	 * - **drag and drop**, for the one already open in another window.
	 *
	 * Paste and drop are wired by the box that owns the textarea rather than
	 * here — they are events on *that* element, and a component that grabbed them
	 * from the document would swallow a paste meant for something else on the
	 * page. This renders the state and offers the chooser; {@link Uploads} holds
	 * it.
	 *
	 * Thumbnails come from a local object URL, so a picture is on screen before
	 * the round trip finishes. A still-uploading one is dimmed rather than hidden:
	 * it is going, and hiding it would read as the drop having missed.
	 *
	 * Anything may be attached, not only pictures (migration 026). A file with
	 * nothing to preview shows its name in the same sized box, so a row of four
	 * attachments is still a row of four boxes whatever is in them — and the
	 * chooser offers no `accept` filter, because the server's answer to "will you
	 * take this" is now "yes, unless it is too big".
	 */
	import type { Uploads } from './uploads.svelte';
	import { ATTACHMENT_MAX } from './uploads.svelte';

	let {
		uploads,
		/** Text for the chooser, so a reply box and the composer can differ. */
		label = 'Add file'
	}: {
		uploads: Uploads;
		label?: string;
	} = $props();

	let chooser = $state<HTMLInputElement | null>(null);

	async function chosen(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		await uploads.add(input.files ?? []);
		// Cleared, or choosing the same file twice in a row does nothing: the
		// `change` event never fires for an unchanged value.
		input.value = '';
	}
</script>

<div data-attachments class="flex min-w-0 flex-col gap-1.5">
	{#if uploads.items.length > 0}
		<ul class="flex flex-wrap gap-1.5">
			{#each uploads.items as item (item.key)}
				<li class="relative">
					{#if item.preview}
						<img
							src={item.preview}
							alt={item.name}
							class="size-16 rounded border border-border-subtle object-cover {item.state ===
							'uploading'
								? 'opacity-50'
								: ''}"
						/>
					{:else}
						<span
							class="flex size-16 items-center justify-center overflow-hidden rounded border border-border-subtle bg-surface px-1 text-center text-[0.6rem] break-all text-content-muted {item.state ===
							'uploading'
								? 'opacity-50'
								: ''}"
						>
							{item.name}
						</span>
					{/if}

					<button
						type="button"
						aria-label="Remove {item.name}"
						onclick={() => uploads.remove(item.key)}
						class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border-subtle bg-surface text-xs text-content-muted hover:text-content"
					>
						×
					</button>

					{#if item.state === 'uploading'}
						<!--
							A bar across the bottom of the thumbnail, because that is where
							the thumbnail already is: a row of bars somewhere else would move
							the composer's controls down and back up again as files land.

							`percent` is null when nothing can be measured — no
							`XMLHttpRequest`, or a body of unknown length — and then it is the
							indeterminate sweep instead. A bar stuck at zero reads as broken;
							a sweep reads as working.
						-->
						{#if item.percent === null}
							<span
								data-upload-progress
								role="progressbar"
								aria-label="Uploading {item.name}"
								class="thinking-bar absolute inset-x-0 bottom-0 h-1"
							></span>
						{:else}
							<span
								data-upload-progress
								role="progressbar"
								aria-label="Uploading {item.name}"
								aria-valuemin="0"
								aria-valuemax="100"
								aria-valuenow={item.percent}
								class="upload-trough absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-full"
							>
								<span
									class="block h-full rounded-full bg-accent transition-[width] duration-150"
									style="width: {item.percent}%"
								></span>
							</span>
						{/if}
						<span class="sr-only">
							Uploading {item.name}{item.percent === null ? '' : `, ${item.percent}%`}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<div class="flex flex-wrap items-center gap-2 text-xs text-content-muted">
		<button
			type="button"
			disabled={uploads.full}
			onclick={() => chooser?.click()}
			class="rounded border border-border-subtle px-2 py-1 hover:text-content disabled:opacity-50"
		>
			{label}
		</button>
		<span>or paste, or drop one in.</span>

		<!--
			Hidden rather than styled: a file input cannot be made to look like the
			rest of this page, and the button above is what the owner presses.
		-->
		<input
			bind:this={chooser}
			type="file"
			multiple
			onchange={chosen}
			class="hidden"
			aria-hidden="true"
			tabindex="-1"
		/>
	</div>

	{#if uploads.error}
		<p role="alert" class="text-xs text-rose-400">{uploads.error}</p>
	{/if}

	{#if uploads.full}
		<p class="text-xs text-content-muted">
			That is the most one message can carry ({ATTACHMENT_MAX}).
		</p>
	{/if}
</div>
