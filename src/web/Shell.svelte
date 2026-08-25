<script lang="ts">
	/**
	 * The authenticated dashboard shell (design §7).
	 *
	 * Three regions on desktop — projects, timeline, rail — collapsing to a
	 * single column with the sidebar as a drawer on a phone, because a meaningful
	 * share of glancing at this happens on one. The grid is `h-dvh` with each
	 * region scrolling inside itself, so the page never scrolls as a whole and
	 * the timeline's scroll position is a thing this app can reason about (which
	 * is what the "N new" pill depends on).
	 *
	 * The store lives here: one connection per page, opened on mount and closed
	 * on unmount. It is hydrated from the server render first, so the shell paints
	 * with content and then goes live, rather than painting empty and filling in.
	 */
	import { onMount, type Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import RightRail from './RightRail.svelte';
	import Sidebar from './Sidebar.svelte';
	import Theme from './Theme.svelte';
	import TimelineView from './Timeline.svelte';
	import { Timeline } from './timeline.svelte';
	import type { SnapshotResponse, UpdateView } from './types';

	let {
		/** The server-rendered snapshot, stamped with the seq it is good to. */
		snapshot,
		/** The selected project's slug, from `?project=`. */
		project = null,
		agentNames = {},
		/** Injected by the component tests; production builds its own. */
		feed = new Timeline({ project }),
		media
	}: {
		snapshot: SnapshotResponse;
		project?: string | null;
		agentNames?: Record<string, string>;
		feed?: Timeline;
		media?: Snippet<[UpdateView]>;
	} = $props();

	// Deliberately the initial values, read once: the store adopts the snapshot
	// this component was rendered with and then keeps itself up to date from the
	// stream. `+page.svelte` re-keys the whole shell when the selected project
	// changes, so there is no case where a later `snapshot` prop needs adopting.
	// svelte-ignore state_referenced_locally
	feed.hydrate(snapshot);

	let drawer = $state(false);

	onMount(() => {
		feed.start();
		return () => feed.stop();
	});

	const activeProject = $derived(
		feed.projects.find((candidate) => candidate.slug === project) ?? null
	);
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && (drawer = false)} />

<div class="grid h-dvh grid-rows-[auto_1fr] bg-surface text-content">
	<header class="flex items-center gap-2 border-b border-border-subtle px-3 py-2 sm:gap-3 sm:px-4">
		<button
			type="button"
			onclick={() => (drawer = true)}
			aria-label="Open projects"
			aria-expanded={drawer}
			class="rounded border border-border-subtle p-1.5 text-content-muted hover:text-content lg:hidden"
		>
			<svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path d="M1 3h14v2H1zM1 7h14v2H1zM1 11h14v2H1z" />
			</svg>
		</button>

		<h1 class="truncate text-base font-semibold tracking-tight sm:text-lg">
			{activeProject ? activeProject.name : 'Agent Dashboard'}
		</h1>

		<span
			class="ml-auto flex items-center gap-1.5 text-xs text-content-muted"
			role="status"
			aria-label={feed.status === 'live' ? 'Live' : 'Reconnecting'}
		>
			<span
				class="size-2 rounded-full {feed.status === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}"
				aria-hidden="true"
			></span>
			<span class="hidden sm:inline">{feed.status === 'live' ? 'Live' : 'Reconnecting'}</span>
		</span>

		<Theme />

		<a
			href={resolve('/logout')}
			class="rounded border border-border-subtle px-2 py-1 text-sm text-content-muted hover:text-content"
		>
			Sign out
		</a>
	</header>

	<div
		class="grid min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_17rem]"
	>
		<aside class="hidden min-h-0 overflow-y-auto border-r border-border-subtle lg:block">
			<Sidebar projects={feed.projects} activeSlug={project} />
		</aside>

		<main class="min-h-0" aria-label="Update timeline">
			<TimelineView {feed} {agentNames} {media} />
		</main>

		<aside class="hidden min-h-0 overflow-y-auto border-l border-border-subtle xl:block">
			<RightRail />
		</aside>
	</div>
</div>

{#if drawer}
	<!--
		The mobile drawer. A plain overlay rather than a `<dialog>`: it has to be
		dismissible by the backdrop, by Escape, and by following a link inside it,
		and the last of those is not what a modal dialog does.
	-->
	<div class="fixed inset-0 z-40 lg:hidden">
		<button
			type="button"
			aria-label="Close projects"
			onclick={() => (drawer = false)}
			class="absolute inset-0 bg-black/50"
		></button>
		<div
			role="dialog"
			aria-label="Projects"
			class="update-enter absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-border-subtle bg-surface"
		>
			<Sidebar projects={feed.projects} activeSlug={project} onnavigate={() => (drawer = false)} />
		</div>
	</div>
{/if}
