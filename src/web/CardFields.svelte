<script lang="ts">
	/**
	 * What is known about a card, out of the way until it is wanted
	 * (migration 040).
	 *
	 * The owner: "allow agents to set metadata on cards… they are hidden by
	 * default, but can be viewed on the dashboard, and updated by the user and
	 * agent alike."
	 *
	 * So: one line saying how many there are, and nothing else until it is
	 * pressed. A feed is read by scanning what people said, and six rows of
	 * branch names between every card would bury exactly that.
	 *
	 * A value that is a link is rendered as one — `http` and `https` only, and
	 * `rel="noopener noreferrer"`, because an agent wrote it and an agent's text
	 * is untrusted (design §8). Everything else is plain text.
	 */
	import { fieldsOn, linkOf } from './fields';
	import type { CardFieldView } from './types';

	let {
		card,
		/** What is noted across every card on this page. */
		fields = [],
		/** Set one, correct it, or take it off. Absent renders it read-only. */
		onset
	}: {
		card: { kind: string; id: string };
		fields?: CardFieldView[];
		onset?: (name: string, value: string | null) => Promise<void> | void;
	} = $props();

	const mine = $derived(fieldsOn(card, fields));

	let open = $state(false);
	let busy = $state(false);
	let name = $state('');
	let value = $state('');
	/** Which field is being corrected, and what it is being corrected to. */
	let editing = $state<string | null>(null);
	let edited = $state('');

	async function run(work: () => Promise<void> | void): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await work();
		} catch {
			// Swallowed: the row not changing is the failure, and a banner over the
			// feed for a note is louder than what it would report.
		} finally {
			busy = false;
		}
	}
</script>

{#if mine.length > 0 || onset}
	<div class="flex flex-col gap-1" data-testid="card-fields">
		<button
			type="button"
			aria-expanded={open}
			data-testid="fields-toggle"
			onclick={() => (open = !open)}
			class="self-start rounded px-1 py-0.5 text-xs text-content-muted hover:bg-surface-sunken hover:text-content"
		>
			<span aria-hidden="true">{open ? '▾' : '▸'}</span>
			Details{mine.length > 0 ? ` (${mine.length})` : ''}
		</button>

		{#if open}
			<dl
				data-testid="fields-list"
				class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-border-subtle bg-surface-sunken px-2.5 py-2 text-xs"
			>
				{#each mine as field (field.id)}
					{@const href = linkOf(field.value)}
					<dt class="truncate text-content-muted" title={field.name}>{field.name}</dt>
					<dd class="flex min-w-0 items-center gap-1" data-field={field.slug}>
						{#if editing === field.slug}
							<form
								class="flex min-w-0 flex-1 items-center gap-1"
								onsubmit={(event) => {
									event.preventDefault();
									void run(async () => {
										await onset?.(field.name, edited.trim() === '' ? null : edited.trim());
										editing = null;
									});
								}}
							>
								<!-- svelte-ignore a11y_autofocus -->
								<input
									bind:value={edited}
									autofocus
									maxlength="500"
									aria-label="Value for {field.name}"
									data-testid="field-edit"
									class="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-xs text-content"
								/>
								<button
									type="submit"
									disabled={busy}
									class="rounded bg-accent px-1.5 py-0.5 text-[0.7rem] font-medium text-surface disabled:opacity-50"
								>
									Save
								</button>
							</form>
						{:else}
							{#if href}
								<!--
									An agent's link, opened in a new tab and told not to hand this
									page's opener over. `http` and `https` only — `linkOf` refuses
									anything else, which is what keeps `javascript:` out of a card.

									An external address, not a route on this site, so `resolve()` is
									the wrong tool and the rule that asks for it cannot see that.
								-->
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									{href}
									target="_blank"
									rel="noopener noreferrer"
									class="min-w-0 truncate text-accent hover:underline">{field.value}</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{:else}
								<span class="min-w-0 truncate text-content" title={field.value}>{field.value}</span>
							{/if}

							{#if onset}
								<button
									type="button"
									aria-label="Change {field.name}"
									data-edit={field.slug}
									onclick={() => {
										editing = field.slug;
										edited = field.value;
									}}
									class="ml-auto shrink-0 rounded px-1 text-[0.7rem] text-content-muted hover:text-content"
								>
									Edit
								</button>
								<button
									type="button"
									disabled={busy}
									aria-label="Remove {field.name}"
									data-remove={field.slug}
									onclick={() => run(() => onset(field.name, null))}
									class="shrink-0 rounded px-1 text-[0.7rem] text-content-muted hover:text-rose-400 disabled:opacity-50"
								>
									×
								</button>
							{/if}
						{/if}
					</dd>
				{/each}

				{#if mine.length === 0}
					<p class="col-span-2 text-content-muted">Nothing noted on this card yet.</p>
				{/if}

				{#if onset}
					<form
						class="col-span-2 flex items-center gap-1 border-t border-border-subtle pt-1.5"
						onsubmit={(event) => {
							event.preventDefault();
							if (name.trim() === '' || value.trim() === '') return;
							void run(async () => {
								await onset(name.trim(), value.trim());
								name = '';
								value = '';
							});
						}}
					>
						<input
							bind:value={name}
							maxlength="40"
							placeholder="Name"
							aria-label="Field name"
							data-testid="field-name"
							class="w-32 min-w-0 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-xs text-content"
						/>
						<input
							bind:value
							maxlength="500"
							placeholder="Value"
							aria-label="Field value"
							data-testid="field-value"
							class="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-xs text-content"
						/>
						<button
							type="submit"
							disabled={busy || name.trim() === '' || value.trim() === ''}
							class="rounded bg-accent px-2 py-0.5 text-[0.7rem] font-medium text-surface disabled:opacity-50"
						>
							Add
						</button>
					</form>
				{/if}
			</dl>
		{/if}
	</div>
{/if}
