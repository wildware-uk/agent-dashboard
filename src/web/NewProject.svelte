<script lang="ts">
	/**
	 * Create a project from the browser (design §7).
	 *
	 * The endpoint behind this is idempotent on slug, exactly like the MCP tool
	 * (§5), so submitting the same name twice yields the same project rather than
	 * a duplicate — which is why this form needs no double-submit guard beyond
	 * disabling itself while a request is out.
	 *
	 * Nothing is inserted locally on success: `project.created` reaches this tab
	 * on the stream and the sidebar follows, the same way it follows a project an
	 * agent created.
	 */
	import { actionMessage, type OwnerActions } from './actions';

	let {
		actions
	}: {
		actions: OwnerActions;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let name = $state('');
	let description = $state('');

	function close(): void {
		open = false;
		error = null;
		name = '';
		description = '';
	}

	async function create(): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.createProject({
				name: name.trim(),
				description: description.trim() === '' ? null : description.trim()
			});
			close();
		} catch (cause) {
			// The form stays open holding what was typed, because retyping a
			// description to find out the name was the problem is nobody's idea of
			// a good time.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-1" data-new-project>
	<button
		type="button"
		aria-expanded={open}
		onclick={() => (open ? close() : (open = true))}
		class="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-content-muted hover:bg-surface-raised hover:text-content"
	>
		<svg class="size-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
			<path d="M5 1h2v4h4v2H7v4H5V7H1V5h4z" />
		</svg>
		New project
	</button>

	{#if open}
		<div class="flex flex-col gap-2 rounded border border-border-subtle bg-surface-raised p-2">
			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Project name
				<input
					bind:value={name}
					type="text"
					class="rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Description
				<textarea
					bind:value={description}
					rows="2"
					class="rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
				></textarea>
			</label>

			{#if error}
				<p role="alert" class="text-xs text-rose-400">{error}</p>
			{/if}

			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={close}
					class="rounded px-2 py-1 text-xs text-content-muted hover:text-content"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={busy || name.trim() === ''}
					onclick={create}
					class="rounded bg-accent px-2 py-1 text-xs font-medium text-surface disabled:opacity-50"
				>
					Create project
				</button>
			</div>
		</div>
	{/if}
</div>
