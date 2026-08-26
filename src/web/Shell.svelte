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
	 * The stores live here: the timeline's, opened on mount and closed on unmount
	 * and hydrated from the server render first, so the shell paints with content
	 * and then goes live rather than painting empty and filling in; and presence's,
	 * because two regions need it — the rail renders who is online, and the cards
	 * are attributed with the names it learns.
	 */
	import { onMount, type Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import RightRail from './RightRail.svelte';
	import Sidebar from './Sidebar.svelte';
	import TasksPanel from './Tasks.svelte';
	import Theme from './Theme.svelte';
	import TimelineView from './Timeline.svelte';
	import { ownerActions, type OwnerActions } from './actions';
	import { Presence } from './presence.svelte';
	import { Tasks } from './tasks.svelte';
	import { Threads } from './threads.svelte';
	import { Timeline } from './timeline.svelte';
	import type { SnapshotResponse, UpdateView } from './types';

	let {
		/** The server-rendered snapshot, stamped with the seq it is good to. */
		snapshot,
		/** The selected project's slug, from `?project=`. */
		project = null,
		/**
		 * Agent names known before either store has said anything.
		 *
		 * Not how a page supplies them — the server render carries them inside
		 * `snapshot`, which is where a `resync` refetch also finds them — but a
		 * seam for a spec that wants one card named without a fake endpoint.
		 */
		agentNames = {},
		/** Injected by the component tests; production builds its own. */
		feed = new Timeline({ project }),
		/**
		 * Live agents, owned here rather than in the rail (design §4, §7).
		 *
		 * The rail is not the only region that needs presence: an agent that
		 * registers a session while this page is open has to start being named on
		 * its cards without a reload, and the timeline snapshot alone cannot do
		 * that — it was read before the agent existed. So one store lives here and
		 * both regions read it.
		 */
		presence = new Presence(),
		/**
		 * The task list (design §5, §7).
		 *
		 * One store, rendered twice: in the rail on a desktop, and in the drawer
		 * that makes the rail reachable on a phone. It refcounts its holders so the
		 * drawer closing does not unsubscribe the rail's copy.
		 */
		tasks = new Tasks({ project }),
		/**
		 * The page's message threads (design §7).
		 *
		 * Owned here for the same reason presence is: one store per page, read by
		 * every card. Reading them here also means one request for the whole
		 * timeline instead of one per card (`threads.svelte.ts`).
		 */
		threads = new Threads({ project }),
		media,
		/**
		 * The owner's write calls (design §7), handed down to the sidebar and to
		 * every card. Injectable for the same reason `feed` is: a spec drives real
		 * clicks without a server.
		 */
		actions = ownerActions()
	}: {
		snapshot: SnapshotResponse;
		project?: string | null;
		agentNames?: Record<string, string>;
		feed?: Timeline;
		presence?: Presence;
		tasks?: Tasks;
		threads?: Threads;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
	} = $props();

	// Deliberately the initial values, read once: the store adopts the snapshot
	// this component was rendered with and then keeps itself up to date from the
	// stream. `+page.svelte` re-keys the whole shell when the selected project
	// changes, so there is no case where a later `snapshot` prop needs adopting.
	// svelte-ignore state_referenced_locally
	feed.hydrate(snapshot);

	let drawer = $state(false);
	/** The right rail as a drawer, which is how a phone reaches it (design §7). */
	let rail = $state(false);

	onMount(() => {
		feed.start();
		// Presence is started here as well as by the rail. Both calls are cheap and
		// idempotent, and the point is that a card's attribution must not depend on
		// the rail being on screen: the rail is a `hidden xl:block` region, and a
		// narrower viewport must still name its agents.
		presence.start();
		// The threads on the cards this page is showing. Started here rather than in
		// a card, because a card is mounted and unmounted as the feed moves and the
		// conversation must not be refetched every time one scrolls past.
		threads.start();
		return () => {
			feed.stop();
			presence.stop();
			threads.stop();
		};
	});

	const activeProject = $derived(
		feed.projects.find((candidate) => candidate.slug === project) ?? null
	);

	/**
	 * Who each card is attributed to, least current source first.
	 *
	 * The timeline snapshot names every agent this deployment has ever had, which
	 * is what a history of departed agents needs; presence names the ones that
	 * have said something since the page loaded, which is what a *new* agent
	 * needs. Neither is a subset of the other, so the card gets both.
	 */
	const posters = $derived({ ...agentNames, ...feed.agentNames, ...presence.names });
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		drawer = false;
		rail = false;
	}}
/>

<div class="grid h-dvh grid-rows-[auto_1fr] bg-surface text-content">
	<!--
		`min-w-0` for the same reason `<main>` below carries it: this header is a
		grid item, so it defaults to `min-width: auto` and refuses to shrink below
		the intrinsic width of its controls. With two drawer toggles rather than
		one it no longer fits a 375px phone, and without this it widens the layout
		viewport and zooms the whole dashboard out (design §7).
	-->
	<header
		class="flex min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-2 sm:gap-3 sm:px-4"
	>
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

		<button
			type="button"
			onclick={() => (rail = true)}
			aria-label="Open agents and tasks"
			aria-expanded={rail}
			class="rounded border border-border-subtle p-1.5 text-content-muted hover:text-content xl:hidden"
		>
			<svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path d="M2 2h5v5H2zM9 2h5v2H9zM9 6h5v2H9zM2 9h5v5H2zM9 10h5v2H9zM9 13h5v1H9z" />
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

		<!--
			`whitespace-nowrap` keeps this the one control that cannot be shrunk into
			two lines. It is the only multi-word label in the header, so without it
			the shrink a 375px phone needs lands here and breaks "Sign out" over two
			rows; with it the shrink lands on the title, which already truncates.
		-->
		<a
			href={resolve('/logout')}
			class="rounded border border-border-subtle px-2 py-1 text-sm whitespace-nowrap text-content-muted hover:text-content"
		>
			Sign out
		</a>
	</header>

	<div
		class="grid min-h-0 min-w-0 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_17rem]"
	>
		<aside class="hidden min-h-0 overflow-y-auto border-r border-border-subtle lg:block">
			<Sidebar projects={feed.projects} activeSlug={project} {actions} />
		</aside>

		<!--
			`min-w-0` is load-bearing, not tidiness. A grid item defaults to
			`min-width: auto`, so it refuses to shrink below its content's intrinsic
			width — one wide update dragged a 375px phone's layout viewport out to
			723px, and the browser zoomed the whole dashboard out to compensate
			(design §7).
		-->
		<main class="min-h-0 min-w-0" aria-label="Update timeline">
			<TimelineView {feed} agentNames={posters} {media} {actions} {threads} />
		</main>

		<aside class="hidden min-h-0 overflow-y-auto border-l border-border-subtle xl:block">
			<RightRail {presence} />
			<div class="border-t border-border-subtle p-3">
				<TasksPanel {tasks} {project} projects={feed.projects} agentNames={posters} {actions} />
			</div>
		</aside>
	</div>
</div>

{#if rail}
	<!--
		The rail as a drawer, below the `xl` breakpoint where the column is hidden.
		Design §7 is explicit that information which only exists in the rail on a
		desktop has to be reachable on a phone, and live agents plus the task list
		are exactly that. The same components, not a reduced copy of them.
	-->
	<div class="fixed inset-0 z-40 xl:hidden">
		<button
			type="button"
			aria-label="Close agents and tasks"
			onclick={() => (rail = false)}
			class="absolute inset-0 bg-black/50"
		></button>
		<div
			role="dialog"
			aria-label="Agents and tasks"
			class="update-enter absolute inset-y-0 right-0 w-80 max-w-[90vw] overflow-y-auto border-l border-border-subtle bg-surface"
		>
			<RightRail {presence} />
			<div class="border-t border-border-subtle p-3">
				<TasksPanel {tasks} {project} projects={feed.projects} agentNames={posters} {actions} />
			</div>
		</div>
	</div>
{/if}

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
			<Sidebar
				projects={feed.projects}
				activeSlug={project}
				onnavigate={() => (drawer = false)}
				{actions}
			/>
		</div>
	</div>
{/if}
