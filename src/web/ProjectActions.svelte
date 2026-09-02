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
	import { mediaUrl } from './media';
	import type { BoardColumn, MediaView, ProjectView, TaskState } from './types';

	let {
		project,
		/**
		 * Images already posted into this project, offered as logos (design §7).
		 *
		 * A picker rather than an upload box, because `media.agent_id` is not
		 * nullable: every image here was posted by an agent, and the owner has no
		 * author to upload as. An agent wanting a logo the timeline has never seen
		 * uploads it with `create_upload` and names it in `set_project_theme`; this
		 * is the owner's route to the same thing.
		 */
		images = [],
		actions
	}: {
		project: ProjectView;
		images?: MediaView[];
		actions: OwnerActions;
	} = $props();

	let open = $state(false);
	let editing = $state(false);
	let styling = $state(false);
	let arranging = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	/** The edit form's own copies, so a refusal does not lose what was typed. */
	let name = $state('');
	let description = $state('');

	const archived = $derived(project.status === 'archived');

	/**
	 * The colour inputs' own values.
	 *
	 * `<input type="color">` has no empty state — it is `#000000` when it has
	 * nothing — so the defaults here are the dashboard's own colours rather than
	 * black, and clearing is a button rather than an absence.
	 */
	let background = $state('#111419');
	let accent = $state('#5aa2f5');

	function close(): void {
		open = false;
		editing = false;
		styling = false;
		arranging = false;
		error = null;
	}

	function edit(): void {
		name = project.name;
		description = project.description ?? '';
		editing = true;
		error = null;
	}

	/** The default board, restated here so the editor opens on something real. */
	const DEFAULT_COLUMNS: BoardColumn[] = [
		{ title: 'To do', states: ['todo'] },
		{ title: 'In progress', states: ['claimed'] },
		{ title: 'Done', states: ['done'] }
	];

	const STATES: { value: TaskState; label: string }[] = [
		{ value: 'todo', label: 'Waiting' },
		{ value: 'claimed', label: 'In progress' },
		{ value: 'done', label: 'Done' },
		{ value: 'cancelled', label: 'Cancelled' }
	];

	/** The columns being edited. A copy, so Cancel really cancels. */
	let columns = $state<BoardColumn[]>([]);

	function arrange(): void {
		columns = (project.board?.columns ?? DEFAULT_COLUMNS).map((column) => ({
			title: column.title,
			states: [...column.states]
		}));
		arranging = true;
		error = null;
	}

	/**
	 * Move a state into a column, taking it out of whichever column had it.
	 *
	 * A task is in exactly one place on a board, so a state belongs to exactly one
	 * column — the server refuses anything else, and letting the editor build a
	 * board it would refuse is how a form ends in an error nobody can act on.
	 */
	function assign(index: number, state: TaskState, on: boolean): void {
		columns = columns.map((column, at) => ({
			title: column.title,
			states: on
				? at === index
					? [...new Set([...column.states, state])]
					: column.states.filter((member) => member !== state)
				: at === index
					? column.states.filter((member) => member !== state)
					: column.states
		}));
	}

	function style(): void {
		background = project.theme?.background ?? '#111419';
		accent = project.theme?.accent ?? '#5aa2f5';
		styling = true;
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
			{#if arranging}
				<!--
					Columns gather task states rather than being lanes of their own. A
					state is what an agent wrote — `claim_task` writes `claimed` — and a
					column an agent could not write to would be a lane nothing enters.
					So the editor offers the states to collect, not a free-text name
					that would mean nothing to the fleet.
				-->
				{#each columns as column, index (index)}
					<div class="flex flex-col gap-1 rounded border border-border-subtle p-1.5">
						<div class="flex items-center gap-1">
							<input
								value={column.title}
								oninput={(event) =>
									(columns = columns.map((candidate, at) =>
										at === index ? { ...candidate, title: event.currentTarget.value } : candidate
									))}
								aria-label="Column {index + 1} name"
								class="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-xs text-content"
							/>
							{#if columns.length > 1}
								<button
									type="button"
									aria-label="Remove column {index + 1}"
									onclick={() => (columns = columns.filter((_, at) => at !== index))}
									class="rounded px-1 text-xs text-content-muted hover:text-content"
								>
									✕
								</button>
							{/if}
						</div>
						<div class="flex flex-wrap gap-x-2">
							{#each STATES as state (state.value)}
								<label class="flex items-center gap-1 text-[0.65rem] text-content-muted">
									<input
										type="checkbox"
										checked={column.states.includes(state.value)}
										onchange={(event) => assign(index, state.value, event.currentTarget.checked)}
										class="size-3 shrink-0"
									/>
									{state.label}
								</label>
							{/each}
						</div>
					</div>
				{/each}

				<div class="flex flex-wrap justify-end gap-2 px-1 pt-1">
					{#if columns.length < 6}
						<button
							type="button"
							onclick={() => (columns = [...columns, { title: 'New column', states: [] }])}
							class="mr-auto rounded px-2 py-1 text-xs text-content-muted hover:text-content"
						>
							Add column
						</button>
					{/if}
					<button
						type="button"
						onclick={close}
						class="rounded px-2 py-1 text-xs text-content-muted hover:text-content"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => patch({ board: { columns } })}
						class="rounded bg-accent px-2 py-1 text-xs font-medium text-surface disabled:opacity-50"
					>
						Save
					</button>
				</div>
			{:else if styling}
				<!--
					Two colours and nothing else. Everything a themed page needs beyond
					them — readable text, borders, raised surfaces — is derived from the
					background (`./theme.ts`), because asking for seven colours is how a
					theme ends up with dark text on a dark page.
				-->
				<label class="flex items-center justify-between gap-2 px-1 py-1 text-xs text-content">
					Background
					<input
						bind:value={background}
						type="color"
						aria-label="Background colour"
						class="h-7 w-12 cursor-pointer rounded border border-border-subtle bg-surface"
					/>
				</label>
				<label class="flex items-center justify-between gap-2 px-1 py-1 text-xs text-content">
					Buttons and links
					<input
						bind:value={accent}
						type="color"
						aria-label="Accent colour"
						class="h-7 w-12 cursor-pointer rounded border border-border-subtle bg-surface"
					/>
				</label>
				<p class="px-1 pb-1 text-xs text-content-muted">
					Text and borders are chosen to stay readable on whatever you pick.
				</p>

				<div class="flex flex-col gap-1 border-t border-border-subtle px-1 pt-2">
					<span class="text-xs text-content-muted">Logo</span>
					{#if images.length === 0}
						<p class="text-xs text-content-muted" data-testid="no-logo-choices">
							No images in this project yet. Post one, or have an agent upload it with create_upload
							and set it with set_project_theme.
						</p>
					{:else}
						<!--
							The project's own images. Clicking one sets it and leaves the colours
							alone: the server merges a theme field by field, so this cannot wipe an
							accent that is already there.
						-->
						<div class="grid grid-cols-5 gap-1" data-testid="logo-choices">
							{#each images.slice(0, 10) as image (image.id)}
								<button
									type="button"
									disabled={busy}
									aria-label="Use this image as the logo"
									aria-pressed={project.theme?.logoMediaId === image.id}
									onclick={() => patch({ theme: { logoMediaId: image.id } }, false)}
									class="aspect-square overflow-hidden rounded border border-border-subtle hover:border-accent disabled:opacity-50 aria-pressed:border-accent"
								>
									<img
										src={mediaUrl(image.id, 'thumb-640')}
										alt=""
										class="size-full object-cover"
									/>
								</button>
							{/each}
						</div>
					{/if}
					{#if project.theme?.logoMediaId}
						<label class="flex items-center gap-2 py-1 text-xs text-content">
							<input
								type="checkbox"
								disabled={busy}
								checked={project.theme?.logoReplacesName ?? false}
								onchange={(event) =>
									patch({ theme: { logoReplacesName: event.currentTarget.checked } }, false)}
								class="size-3.5 shrink-0"
							/>
							Use the logo instead of the name
						</label>
						<button
							type="button"
							disabled={busy}
							onclick={() => patch({ theme: { logoMediaId: null } }, false)}
							class="self-start rounded px-1 py-0.5 text-xs text-content-muted hover:text-content disabled:opacity-50"
						>
							Remove logo
						</button>
					{/if}
				</div>
				<div class="flex justify-end gap-2 px-1 pt-1">
					{#if project.theme}
						<button
							type="button"
							disabled={busy}
							onclick={() => patch({ theme: null })}
							class="mr-auto rounded px-2 py-1 text-xs text-content-muted hover:text-content disabled:opacity-50"
						>
							Reset
						</button>
					{/if}
					<button
						type="button"
						onclick={close}
						class="rounded px-2 py-1 text-xs text-content-muted hover:text-content"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => patch({ theme: { background, accent } })}
						class="rounded bg-accent px-2 py-1 text-xs font-medium text-surface disabled:opacity-50"
					>
						Save
					</button>
				</div>
			{:else if editing}
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
					onclick={style}
					data-testid="style-project"
					class="rounded px-2 py-1 text-left hover:bg-surface"
				>
					{project.theme ? 'Change colours' : 'Set colours'}
				</button>
				<button
					type="button"
					onclick={arrange}
					data-testid="arrange-board"
					class="rounded px-2 py-1 text-left hover:bg-surface"
				>
					Board columns
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
