<script lang="ts">
	/**
	 * The project sidebar (design §7): pinned first, archived collapsed behind a
	 * toggle.
	 *
	 * The server already orders projects pinned-first, but the partition and the
	 * sort are repeated here so the component is correct on its own — a sidebar
	 * that silently depends on the order of its input is a sidebar that breaks
	 * the first time someone reuses it.
	 */
	import { resolve } from '$app/paths';
	import NewProject from './NewProject.svelte';
	import ProjectActions from './ProjectActions.svelte';
	import type { OwnerActions } from './actions';
	import type { ProjectView } from './types';

	let {
		projects,
		/** The selected project's slug, or `null` for the whole timeline. */
		activeSlug = null,
		/** Called after a navigation, so the mobile drawer can close itself. */
		onnavigate,
		/**
		 * The owner's write calls (design §7). Given one, the sidebar grows a
		 * create form and a per-project menu; without one it is a read-only list.
		 *
		 * Opt-in rather than always-on because this component is also the drawer,
		 * the empty state and every spec in `Sidebar.svelte.spec.ts` — and a
		 * navigation component that cannot be rendered without a server behind it
		 * is a component nobody can reason about.
		 */
		actions
	}: {
		projects: ProjectView[];
		activeSlug?: string | null;
		onnavigate?: () => void;
		actions?: OwnerActions;
	} = $props();

	let showArchived = $state(false);

	const pinnedFirst = (list: ProjectView[]) =>
		[...list].sort((left, right) => Number(right.pinned) - Number(left.pinned));

	const active = $derived(pinnedFirst(projects.filter((project) => project.status === 'active')));
	const archived = $derived(
		pinnedFirst(projects.filter((project) => project.status === 'archived'))
	);

	const href = (slug: string) => resolve('/projects/[slug]', { slug });
</script>

<nav aria-label="Projects" class="flex flex-col gap-4 p-3 text-sm">
	<a
		href={resolve('/')}
		onclick={onnavigate}
		aria-current={activeSlug === null ? 'page' : undefined}
		class="rounded px-2 py-1.5 font-medium hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:text-content"
	>
		All projects
	</a>

	<div class="flex flex-col gap-1">
		<div class="flex items-center justify-between gap-2">
			<h2 class="px-2 text-xs font-semibold tracking-wide text-content-muted uppercase">
				Projects
			</h2>
			{#if actions}
				<NewProject {actions} />
			{/if}
		</div>
		{#if active.length === 0}
			<p class="px-2 py-1 text-content-muted">No projects yet.</p>
		{:else}
			<ul class="flex flex-col gap-0.5">
				{#each active as project (project.id)}
					<!--
						`group` is what lets the manage menu stay invisible until the row is
						hovered or focused, so the sidebar reads as navigation first.
					-->
					<li class="group flex items-center gap-1">
						<a
							href={href(project.slug)}
							onclick={onnavigate}
							aria-current={project.slug === activeSlug ? 'page' : undefined}
							class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:text-content"
						>
							{#if project.pinned}
								<svg
									class="size-3.5 shrink-0 text-accent"
									viewBox="0 0 16 16"
									fill="currentColor"
									aria-hidden="true"
								>
									<path
										d="M9.5 1.5 14.5 6.5l-1.8.4-2.3 2.3.7 3.6-1.1 1.1L6.6 10 3 13.6 2 12.6l3.6-3.6L1.7 5.1l1.1-1.1 3.6.7 2.3-2.3z"
									/>
								</svg>
								<span class="sr-only">Pinned</span>
							{/if}
							<span class="truncate">{project.name}</span>
						</a>
						{#if actions}
							<ProjectActions {project} {actions} />
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if archived.length > 0}
		<div class="flex flex-col gap-1">
			<button
				type="button"
				onclick={() => (showArchived = !showArchived)}
				aria-expanded={showArchived}
				class="flex items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-content-muted uppercase hover:text-content"
			>
				<svg
					class="size-3 transition-transform {showArchived ? 'rotate-90' : ''}"
					viewBox="0 0 12 12"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M4 2l5 4-5 4z" />
				</svg>
				Archived ({archived.length})
			</button>
			{#if showArchived}
				<ul class="flex flex-col gap-0.5">
					{#each archived as project (project.id)}
						<li class="group flex items-center gap-1">
							<a
								href={href(project.slug)}
								onclick={onnavigate}
								aria-current={project.slug === activeSlug ? 'page' : undefined}
								class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-content-muted hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:text-content"
							>
								<span class="truncate">{project.name}</span>
							</a>
							<!-- Reachable here too, or an archived project could never come back. -->
							{#if actions}
								<ProjectActions {project} {actions} />
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</nav>
