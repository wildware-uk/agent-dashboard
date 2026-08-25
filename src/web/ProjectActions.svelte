<script lang="ts">
	/**
	 * The owner's controls on one project (design §7): pin, archive, rename and
	 * re-describe.
	 *
	 * Behind a menu rather than four permanent icons, because the sidebar is a
	 * navigation surface first and a management surface second — a row that is
	 * half controls is a row that is hard to click the *project* in.
	 *
	 * Like every control in this slice it sends one `PATCH` and then does
	 * nothing: the row it changed comes back over the stream, which is what keeps
	 * this tab and a second open tab in agreement.
	 */
	import { actionMessage, type OwnerActions, type ProjectPatch } from './actions';
	import type { ProjectView } from './types';

	let {
		project,
		actions
	}: {
		project: ProjectView;
		actions: OwnerActions;
	} = $props();

	let open = $state(false);
	let editing = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	/** The edit form's own copies, so a refusal does not lose what was typed. */
	let name = $state('');
	let description = $state('');

	const archived = $derived(project.status === 'archived');

	function close(): void {
		open = false;
		editing = false;
		error = null;
	}

	function edit(): void {
		name = project.name;
		description = project.description ?? '';
		editing = true;
		error = null;
	}

	async function patch(input: ProjectPatch, thenClose = true): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.patchProject(project.slug, input);
			if (thenClose) close();
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	function save(): void {
		// An empty description is *cleared*, not stored as a blank string: the
		// column is nullable and the sidebar renders "no description" from null.
		void patch({
			name: name.trim(),
			description: description.trim() === '' ? null : description.trim()
		});
	}
</script>

<!--
	The Escape handler sits on the wrapper so it catches a key pressed on any
	control inside the menu, which is where the focus actually is.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="relative"
	data-project-actions
	onkeydown={(event) => {
		if (event.key === 'Escape') close();
	}}
>
	<button
		type="button"
		aria-label="Manage {project.name}"
		title="Manage {project.name}"
		aria-expanded={open}
		onclick={() => (open ? close() : (open = true))}
		class="rounded p-1 text-content-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface hover:text-content aria-expanded:opacity-100"
	>
		<svg class="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path
				d="M3 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"
			/>
		</svg>
	</button>

	{#if open}
		<div
			class="absolute right-0 z-20 mt-1 flex w-56 flex-col gap-1 rounded border border-border-subtle bg-surface-raised p-1.5 text-sm shadow-lg"
		>
			{#if editing}
				<label class="flex flex-col gap-1 px-1 py-0.5 text-xs text-content-muted">
					Project name
					<input
						bind:value={name}
						type="text"
						class="rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
					/>
				</label>
				<label class="flex flex-col gap-1 px-1 py-0.5 text-xs text-content-muted">
					Description
					<textarea
						bind:value={description}
						rows="3"
						class="rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
					></textarea>
				</label>
				<div class="flex justify-end gap-2 px-1 pt-1">
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
						onclick={save}
						class="rounded bg-accent px-2 py-1 text-xs font-medium text-surface disabled:opacity-50"
					>
						Save
					</button>
				</div>
			{:else}
				<button
					type="button"
					disabled={busy}
					onclick={() => patch({ pinned: !project.pinned })}
					class="rounded px-2 py-1 text-left hover:bg-surface disabled:opacity-50"
				>
					{project.pinned ? 'Unpin project' : 'Pin project'}
				</button>
				<button type="button" onclick={edit} class="rounded px-2 py-1 text-left hover:bg-surface">
					Rename project
				</button>
				<button
					type="button"
					disabled={busy}
					onclick={() => patch({ status: archived ? 'active' : 'archived' })}
					class="rounded px-2 py-1 text-left hover:bg-surface disabled:opacity-50"
				>
					{archived ? 'Unarchive project' : 'Archive project'}
				</button>
				<p class="px-2 pb-0.5 text-xs text-content-muted">
					Archiving hides it from the sidebar. Its updates stay.
				</p>
			{/if}

			{#if error}
				<p role="alert" class="px-2 py-0.5 text-xs text-rose-400">{error}</p>
			{/if}
		</div>
	{/if}
</div>
