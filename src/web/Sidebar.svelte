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
	import type { MediaView, ProjectView } from './types';

	let {
		projects,
		/** The selected project's slug, or `null` for the whole timeline. */
		activeSlug = null,
		/**
		 * How many agents are blocked on the owner, per project id (design §7).
		 *
		 * This is what makes it safe for the request cards to live inside one
		 * project's feed: a blocked agent somewhere else is a number on the row that
		 * navigates to it, rather than something the owner has to go looking for.
		 */
		requestCounts = {},
		/**
		 * Every pending request, for the "All projects" row.
		 *
		 * Not the sum of {@link requestCounts}: a request an agent posted without a
		 * project has no row of its own, and the whole-timeline feed is the only
		 * place it can be answered. Counting it here is what keeps it findable.
		 */
		totalRequests = 0,
		/**
		 * Updates per project id that have landed since the owner last opened it.
		 *
		 * A different question from {@link requestCounts} and shown in a different
		 * colour for that reason: amber is "an agent is blocked on you", this is
		 * "things happened here". Conflating them would make the urgent one stop
		 * meaning anything.
		 */
		unseenCounts = {},
		/**
		 * How many tasks are outstanding, for the count beside the Tasks link.
		 *
		 * Open ones only — todo and claimed. A total that included everything ever
		 * finished would be a number that only ever goes up.
		 */
		openTasks = 0,
		/**
		 * Ready images per project id, for the logo picker in the manage menu.
		 *
		 * Passed through rather than fetched: the shell already has the timeline,
		 * and a logo is an image an agent posted into the project.
		 */
		projectImages = {},
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
		requestCounts?: Record<string, number>;
		totalRequests?: number;
		unseenCounts?: Record<string, number>;
		openTasks?: number;
		projectImages?: Record<string, MediaView[]>;
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

<!--
	The waiting count. Solid amber with black ink for the same reason the card's
	chip is: it has to be legible on the raised row, the flat row and both themes
	without depending on what is behind it. The digits are hidden from screen
	readers and replaced with a sentence, because "3" on its own says nothing.
-->
{#snippet waiting(count: number)}
	<span
		data-testid="request-badge"
		class="ml-auto shrink-0 rounded-full bg-amber-500 px-1.5 py-0.5 text-[0.65rem] font-semibold text-black tabular-nums"
	>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{count} waiting on you</span>
	</span>
{/snippet}

<!--
	The "new since you last looked" count. Sky rather than amber, and it sits
	*after* the amber one where a row carries both, so the urgent badge keeps the
	position the eye already learned. Same black ink for the same reason: it has
	to be legible on the raised row, the flat row and both themes.

	`ml-auto` is on whichever badge comes first, so a row with only this one still
	pushes it to the right edge.
-->
{#snippet fresh(count: number, first: boolean)}
	<span
		data-testid="unseen-badge"
		class="{first
			? 'ml-auto '
			: ''}shrink-0 rounded-full bg-sky-500 px-1.5 py-0.5 text-[0.65rem] font-semibold text-black tabular-nums"
	>
		<span aria-hidden="true">{count}</span>
		<span class="sr-only">{count} new since you last looked</span>
	</span>
{/snippet}

<nav aria-label="Projects" class="flex flex-col gap-4 p-3 text-sm">
	<a
		href={resolve('/')}
		onclick={onnavigate}
		aria-current={activeSlug === null ? 'page' : undefined}
		class="flex items-center gap-2 rounded px-2 py-1.5 font-medium hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:text-content"
	>
		<span class="truncate">All projects</span>
		{#if totalRequests > 0}{@render waiting(totalRequests)}{/if}
	</a>

	<!--
		Tasks are the long-running half of the product — what is being worked on, as
		opposed to what happened — and until this link they lived only in a rail that
		is `xl:block`, invisible below 1280px and behind a drawer nobody opens.
	-->
	<a
		href={resolve('/tasks')}
		onclick={onnavigate}
		data-testid="tasks-link"
		class="flex items-center gap-2 rounded px-2 py-1.5 font-medium hover:bg-surface-raised"
	>
		<svg class="size-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h8v2H2z" />
		</svg>
		<span class="truncate">Tasks</span>
		{#if openTasks > 0}
			<span
				class="ml-auto shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[0.65rem] font-semibold text-content-muted tabular-nums"
				data-testid="open-tasks"
			>
				<span aria-hidden="true">{openTasks}</span>
				<span class="sr-only">{openTasks} open</span>
			</span>
		{/if}
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
							{#if requestCounts[project.id]}{@render waiting(requestCounts[project.id])}{/if}
							{#if unseenCounts[project.id]}
								{@render fresh(unseenCounts[project.id], !requestCounts[project.id])}
							{/if}
						</a>
						{#if actions}
							<ProjectActions {project} images={projectImages[project.id] ?? []} {actions} />
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
								{#if requestCounts[project.id]}{@render waiting(requestCounts[project.id])}{/if}
								{#if unseenCounts[project.id]}
									{@render fresh(unseenCounts[project.id], !requestCounts[project.id])}
								{/if}
							</a>
							<!-- Reachable here too, or an archived project could never come back. -->
							{#if actions}
								<ProjectActions {project} images={projectImages[project.id] ?? []} {actions} />
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</nav>
