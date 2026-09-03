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
	import Board from './Board.svelte';
	import Composer from './Composer.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import NotifyToggle from './NotifyToggle.svelte';
	import RightRail from './RightRail.svelte';
	import Sidebar from './Sidebar.svelte';
	import TasksPanel from './Tasks.svelte';
	import Theme from './Theme.svelte';
	import TimelineView from './Timeline.svelte';
	import { ownerActions, type OwnerActions } from './actions';
	import { Presence } from './presence.svelte';
	import { Push } from './push.svelte';
	import { Notifications } from './notifications.svelte';
	import { Requests } from './requests.svelte';
	import { claimsMove, readSwipe } from './swipe';
	import { Tasks } from './tasks.svelte';
	import { Threads } from './threads.svelte';
	import { Timeline } from './timeline.svelte';
	import { mediaUrl } from './media';
	import { themeStyle } from './theme';
	import type { MediaView, RequestView, SnapshotResponse, UpdateView } from './types';

	/** The centre column's two views (design §7). */
	type ShellView = 'feed' | 'board';

	/**
	 * Which view this browser was last on, remembered per browser.
	 *
	 * `localStorage` and not the server: this is a preference about one screen,
	 * not about the project, and a laptop left on the board while a phone reads
	 * the feed is two correct answers rather than a conflict.
	 */
	function defaultViewMemory() {
		const KEY = 'agent-dashboard:view';
		return {
			view(): ShellView | null {
				try {
					const stored = globalThis.localStorage?.getItem(KEY);
					return stored === 'feed' || stored === 'board' ? stored : null;
				} catch {
					return null;
				}
			},
			set(value: ShellView): void {
				try {
					globalThis.localStorage?.setItem(KEY, value);
				} catch {
					// Private mode: the choice lasts for this page only.
				}
			}
		};
	}

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
		/**
		 * What agents are waiting on the owner for (design §5, §7).
		 *
		 * Owned here rather than by the feed because the queue must not be scoped
		 * to the project on screen: a request is aimed at the owner, and an agent
		 * stopped dead in another project still has to be visible — as a card when
		 * the feed spans every project, and as a count on the sidebar row when it
		 * does not.
		 */
		requests = new Requests(),
		/**
		 * Whether this browser is subscribed to Web Push (design §7).
		 *
		 * Owned here so the header's toggle is built with the page rather than
		 * inside a component a spec cannot reach, and injectable for the same
		 * reason every other store here is.
		 */
		push = new Push(),
		/**
		 * What the owner has been told about (migration 021).
		 *
		 * Owned here because the bell is in the header, above every view, and
		 * because a notification is aimed at the owner rather than at the project
		 * on screen — the same reason `requests` lives here.
		 */
		notifications = new Notifications(),
		/**
		 * What a notification points at, from `?focus=` (migration 021).
		 *
		 * Clicking one has to land on the card or the reply itself; a route that
		 * dropped its owner at the top of a project with fifty cards under it is
		 * the thing they asked me to fix.
		 */
		focus = null,
		media,
		/**
		 * The owner's write calls (design §7), handed down to the sidebar and to
		 * every card. Injectable for the same reason `feed` is: a spec drives real
		 * clicks without a server.
		 */
		actions = ownerActions(),
		/**
		 * Which view the centre column starts on (design §7).
		 *
		 * A prop so a spec can open straight onto the board; production always
		 * renders `feed` first and then adopts whatever this browser last chose, on
		 * mount rather than during render — reading `localStorage` while the server
		 * cannot would make the two renders disagree and break hydration.
		 */
		view = 'feed',
		/** Injected by the specs; the shell reads the browser's own. */
		remember = defaultViewMemory()
	}: {
		snapshot: SnapshotResponse;
		project?: string | null;
		agentNames?: Record<string, string>;
		feed?: Timeline;
		presence?: Presence;
		notifications?: Notifications;
		focus?: string | null;
		tasks?: Tasks;
		threads?: Threads;
		requests?: Requests;
		push?: Push;
		media?: Snippet<[UpdateView]>;
		actions?: OwnerActions;
		view?: ShellView;
		remember?: { view(): ShellView | null; set(view: ShellView): void };
	} = $props();

	/**
	 * Which of the two views the centre column is showing.
	 *
	 * The feed is "what happened" and the board is "what is being worked on" —
	 * two ways of looking at one project rather than two halves of one screen, so
	 * each gets the whole column instead of the board riding above the feed as a
	 * strip that scrolled away exactly when it was wanted.
	 */
	// Deliberately the initial value: after the first render this is the owner's
	// to change, and a later prop must not yank the column out from under them.
	// svelte-ignore state_referenced_locally
	let tab = $state<ShellView>(view);

	function show(next: ShellView): void {
		tab = next;
		remember.set(next);
	}

	// Deliberately the initial values, read once: the store adopts the snapshot
	// this component was rendered with and then keeps itself up to date from the
	// stream. `+page.svelte` re-keys the whole shell when the selected project
	// changes, so there is no case where a later `snapshot` prop needs adopting.
	// svelte-ignore state_referenced_locally
	feed.hydrate(snapshot);
	// Threads come with the server render too, so a card's replies are on screen
	// at first paint rather than appearing a beat later once a fetch on mount
	// returns — which reads as the conversation having been empty and then filling
	// in. The store still refetches on `message.created` exactly as before.
	// svelte-ignore state_referenced_locally
	if (snapshot.messages)
		threads.hydrate({
			seq: snapshot.seq,
			at: snapshot.at,
			messages: snapshot.messages,
			// Carried through, or a tick would be absent at first paint and appear
			// on the first refetch — which reads as the agent having only just
			// acknowledged something it acknowledged an hour ago (migration 013).
			acks: snapshot.acks,
			// The images on those messages (migration 016), for the same reason the
			// acks are here: a picture that appeared a beat after the words reads as
			// having just been added to them.
			media: snapshot.messageMedia
		});

	let drawer = $state(false);
	/**
	 * The edge swipe that opens the project drawer (design §7).
	 *
	 * The owner asked for it "instead of going back", and that is the whole
	 * difficulty: a drag from the left edge is the browser's own back gesture, so
	 * the only way to mean something else by it is to claim it on the *first*
	 * touch — `preventDefault` on a non-passive `touchstart`, before there is any
	 * movement to judge. Being wrong there costs a scroll that does not navigate
	 * back; not claiming it at all costs the feature.
	 *
	 * Only below `lg`, where the sidebar is a drawer rather than a column: on a
	 * desktop the projects are already on screen and a swipe would open a copy of
	 * what somebody is looking at.
	 */
	let touch: { x: number; y: number } | null = null;

	const narrow = () =>
		typeof window === 'undefined' ? false : !window.matchMedia('(min-width: 1024px)').matches;

	function ontouchstart(event: TouchEvent): void {
		if (!narrow() || event.touches.length !== 1) return;
		const point = event.touches[0]!;
		touch = { x: point.clientX, y: point.clientY };
	}

	/**
	 * Refuse the browser's gesture — but only once there is a gesture.
	 *
	 * This used to happen on `touchstart`, which refused the default action of
	 * every touch it applied to. On a phone that meant the project links in the
	 * open drawer could be seen and not selected: a tap is a touch with no
	 * movement, and it was being cancelled before it could become a click. So the
	 * claim waits for movement, which a tap never has, and still arrives early
	 * enough to stop a back swipe.
	 */
	function ontouchmove(event: TouchEvent): void {
		const start = touch;
		if (!start || !narrow() || event.touches.length !== 1) return;

		const point = event.touches[0]!;
		const claimed = claimsMove(
			{ startX: start.x, dx: point.clientX - start.x, dy: point.clientY - start.y },
			drawer
		);
		if (claimed && event.cancelable) event.preventDefault();
	}

	function forgetTouch(): void {
		touch = null;
	}

	function ontouchend(event: TouchEvent): void {
		const start = touch;
		touch = null;
		if (!start || !narrow()) return;

		const point = event.changedTouches[0];
		if (!point) return;

		const verdict = readSwipe(
			{
				startX: start.x,
				startY: start.y,
				endX: point.clientX,
				endY: point.clientY,
				width: window.innerWidth
			},
			drawer
		);
		if (verdict === 'open-left') drawer = true;
		if (verdict === 'close-left') drawer = false;
	}

	/** The right rail as a drawer, which is how a phone reaches it (design §7). */
	let rail = $state(false);

	onMount(() => {
		// After the first render, never during it: the server has no `localStorage`,
		// so reading it while rendering would make the two renders disagree.
		const remembered = remember.view();
		if (remembered) tab = remembered;

		feed.start();
		// Presence is started here as well as by the rail. Both calls are cheap and
		// idempotent, and the point is that a card's attribution must not depend on
		// the rail being on screen: the rail is a `hidden xl:block` region, and a
		// narrower viewport must still name its agents.
		presence.start();
		// The request queue. Started here for the same reason presence is: it is
		// read by two regions — the feed's cards and the sidebar's counts — and it
		// is not the timeline's to own.
		requests.start();
		// The threads on the cards this page is showing. Started here rather than in
		// a card, because a card is mounted and unmounted as the feed moves and the
		// conversation must not be refetched every time one scrolls past.
		threads.start();
		// The bell. Started here for the same reason the queue is: it is the
		// owner's, not the project's, and it sits above every view.
		notifications.start();

		// By hand rather than as an attribute, because the option is the point:
		// Svelte registers touch handlers as *passive*, and a passive listener's
		// `preventDefault` is ignored — which is exactly the call that stops the
		// browser treating an edge drag as "go back".
		window.addEventListener('touchstart', ontouchstart, { passive: true });
		// Non-passive, because the option is the point: a passive listener's
		// `preventDefault` is ignored, and that call is what stops the browser
		// treating a sideways drag from the edge as "go back".
		window.addEventListener('touchmove', ontouchmove, { passive: false });
		window.addEventListener('touchend', ontouchend);
		window.addEventListener('touchcancel', forgetTouch);
		return () => {
			feed.stop();
			presence.stop();
			requests.stop();
			threads.stop();
			notifications.stop();
			window.removeEventListener('touchstart', ontouchstart);
			window.removeEventListener('touchmove', ontouchmove);
			window.removeEventListener('touchend', ontouchend);
			window.removeEventListener('touchcancel', forgetTouch);
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

	/**
	 * The images each project already has, for the logo picker (design §7).
	 *
	 * Built from the timeline this page has already loaded rather than from a new
	 * endpoint: a logo is an image an agent posted, and the feed is where those
	 * are. Ready ones only — a `pending` id would render as a broken box in the
	 * header until the pipeline caught up, and the server refuses one anyway.
	 */
	const projectImages = $derived.by(() => {
		const byProject: Record<string, MediaView[]> = {};
		for (const update of feed.items) {
			for (const item of update.media ?? []) {
				if (item.kind !== 'image' || item.status !== 'ready') continue;
				(byProject[update.projectId] ??= []).push(item);
			}
		}
		return byProject;
	});

	/**
	 * Whether the logo stands in for the project name.
	 *
	 * Needs a logo as well as the flag: the server refuses the flag without one,
	 * but a header that rendered neither because of a stale payload would be a
	 * page with no title at all.
	 */
	const wordmark = $derived(
		Boolean(activeProject?.theme?.logoReplacesName && activeProject?.theme?.logoMediaId)
	);

	/** Whether this page is one project's feed rather than the whole timeline. */
	/**
	 * Task id to title, for the chip a card grows when it is progress on one.
	 *
	 * Read off the task store the rail already holds rather than fetched: the
	 * titles are on the page, and a card asking for one would be a lookup per card
	 * for a line of text.
	 */
	const taskTitles = $derived(Object.fromEntries(tasks.items.map((task) => [task.id, task.title])));

	/** Outstanding work, for the count beside the sidebar's Tasks link. */
	const openTasks = $derived(
		tasks.items.filter((task) => task.state === 'todo' || task.state === 'claimed').length
	);

	/** The project's own lanes, or `null` for the default three. */
	const boardColumns = $derived(activeProject?.board ?? null);

	const scoped = $derived(project !== null);

	/**
	 * The requests that belong on the feed being rendered (design §7).
	 *
	 * The store holds every pending request, unscoped, on purpose. Deciding which
	 * of them are *this feed's* is the shell's job because only the shell knows
	 * what the page is showing: the whole timeline shows all of them, and a
	 * project page shows that project's. The rest are not lost — they are the
	 * sidebar's counts, which is what replaced the old always-on banner.
	 *
	 * A slug that names no known project yields nothing rather than everything: a
	 * page that cannot say which project it is must not answer "all of them".
	 */
	const feedRequests = $derived.by(() => {
		const inScope = !scoped
			? requests.items
			: activeProject
				? requests.items.filter((request) => request.projectId === activeProject.id)
				: [];

		// A question asked inside a thread is answered inside that thread
		// (migration 022), so it is not also a card at the top of the feed: one
		// question, one place to answer it. The sidebar count still includes it, so
		// a question in a conversation nobody has scrolled to is still findable.
		return inScope.filter((request) => !request.messageId);
	});

	/** The questions asked in each thread, by the message they were asked under. */
	const threadRequests = $derived.by(() => {
		const map: Record<string, RequestView[]> = {};
		for (const request of requests.items) {
			if (!request.messageId) continue;
			(map[request.messageId] ??= []).push(request);
		}
		return map;
	});

	/**
	 * Project id to name, for the cards — and only when the feed spans more than
	 * one project, because on a project page the name is on every card and says
	 * nothing.
	 */
	const projectNames = $derived(
		scoped
			? {}
			: Object.fromEntries(feed.projects.map((candidate) => [candidate.id, candidate.name]))
	);

	/**
	 * How many agents are blocked, per project, for the sidebar badge.
	 *
	 * Requests with no project are deliberately absent: they have no row to sit
	 * on. They are still answerable — they are cards on the whole-timeline feed,
	 * which is what the "All projects" total counts.
	 */
	const requestCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const request of requests.items) {
			if (request.projectId === null) continue;
			counts[request.projectId] = (counts[request.projectId] ?? 0) + 1;
		}
		return counts;
	});

	/**
	 * Who is beating right now, as ids (design §4).
	 *
	 * Derived from the presence store the rail already holds, so an agent's
	 * "is thinking…" stops the moment its session does — one clock decides who is
	 * online, and everything that depends on it reads the same answer.
	 */
	const onlineIds = $derived(presence.online.map((agent) => agent.agentId));

	/**
	 * The "new since you last looked" counts, minus the project being looked at.
	 *
	 * The server's figure is counted from `owner_seen_at`, which is stamped when
	 * the page opens and again as cards arrive — but there is a beat between a
	 * card landing and that stamp, and a badge that blinked on the row the owner
	 * is currently reading is the one place the count is certainly wrong. So the
	 * open project is subtracted here rather than raced for on the server.
	 */
	const unseenCounts = $derived.by(() => {
		const counts = { ...feed.unseen };
		if (activeProject) delete counts[activeProject.id];
		return counts;
	});

	/**
	 * Stamp the open project as seen — on arrival, and again whenever a new card
	 * lands while the owner is sitting on it.
	 *
	 * Keyed on the newest card rather than run on an interval, so a quiet project
	 * costs one request per visit. Failures are swallowed: the badge is a
	 * convenience, and a stamp that did not land clears on the next visit rather
	 * than costing the owner anything they have to redo.
	 */
	$effect(() => {
		const slug = activeProject?.slug;
		// Read so the effect re-runs when the feed's top card changes.
		void feed.items[0]?.id;
		if (!slug) return;
		void actions.markProjectSeen(slug).catch(() => {});
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		drawer = false;
		rail = false;
	}}
/>

<!--
	The selected project's own styling (design §7).

	Custom properties on the outermost element rather than a stylesheet: the
	tokens `app.css` defines on `:root` are overridden for this subtree and
	everything below inherits, so a themed project restyles the whole dashboard —
	cards, buttons, borders — without a single component knowing it happened. An
	unthemed project emits an empty attribute and nothing changes.

	`themeStyle` re-checks every colour before it is written here; the domain has
	already refused anything that is not a hex literal, and this is the second
	check standing between an API response and a style attribute (`./theme.ts`).
-->
<div
	class="grid h-dvh grid-rows-[auto_1fr] bg-surface text-content"
	style={themeStyle(activeProject?.theme)}
	data-themed={activeProject?.theme ? 'true' : undefined}
>
	<div class="min-w-0">
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

			{#if activeProject?.theme?.logoMediaId}
				<!--
					The project's own mark, from this deployment's media rather than an
					external URL: a logo hosted elsewhere would be a request the owner's
					browser makes to somewhere nobody here controls, on every page load.

					Two shapes. Beside the name it is decorative, so the alt is empty and
					the name carries the meaning. Standing in for the name — a wordmark,
					a logo that *is* the name — the alt becomes the project name, because
					the accessible tree must not lose a name just because the pixels
					carry it. Height-constrained with `w-auto`, since a wordmark is wide
					and a square box would either crop it or pad it.
				-->
				<img
					src={mediaUrl(activeProject.theme.logoMediaId, 'thumb-640')}
					alt={wordmark ? activeProject.name : ''}
					data-testid="project-logo"
					data-wordmark={wordmark ? 'true' : undefined}
					class={wordmark
						? 'h-9 w-auto max-w-[60vw] shrink-0 object-contain sm:h-11'
						: 'size-9 shrink-0 rounded object-contain sm:size-10'}
				/>
			{/if}

			{#if !wordmark}
				<h1 class="truncate text-base font-semibold tracking-tight sm:text-lg">
					{activeProject ? activeProject.name : 'Agent Dashboard'}
				</h1>
			{/if}

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

			<!--
				Push, next to the theme switch: both are "how this browser behaves",
				not "what the dashboard contains". It renders nothing at all on a
				deployment with no VAPID keypair, or in a browser without the APIs.
			-->
			<!--
				Everything the owner has been told about, and a way back to each of
				them (migration 021). Before this, a push that arrived while the phone
				was asleep was the only copy there had ever been.
			-->
			<NotificationBell {notifications} />

			<NotifyToggle {push} />

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
	</div>

	<div
		class="grid min-h-0 min-w-0 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_17rem]"
	>
		<aside class="hidden min-h-0 overflow-y-auto border-r border-border-subtle lg:block">
			<Sidebar
				projects={feed.projects}
				activeSlug={project}
				{requestCounts}
				totalRequests={requests.items.length}
				{unseenCounts}
				{openTasks}
				{projectImages}
				{actions}
			/>
		</aside>

		<!--
			`min-w-0` is load-bearing, not tidiness. A grid item defaults to
			`min-width: auto`, so it refuses to shrink below its content's intrinsic
			width — one wide update dragged a 375px phone's layout viewport out to
			723px, and the browser zoomed the whole dashboard out to compensate
			(design §7).
		-->
		<main class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
			<!--
				The two views of one project (design §7). Tabs rather than one column
				holding both: the feed is read and the board is scanned, and the strip
				the board used to be scrolled away exactly when the owner wanted it.

				Real tab semantics, because they are what a screen reader needs to say
				"2 of 2" — and the panels below carry the matching `role="tabpanel"`.
			-->
			<div
				role="tablist"
				aria-label="Project views"
				class="flex min-w-0 items-center gap-1 border-b border-border-subtle px-3 sm:px-4"
			>
				<button
					type="button"
					role="tab"
					id="tab-feed"
					data-testid="tab-feed"
					aria-selected={tab === 'feed'}
					aria-controls="panel-feed"
					onclick={() => show('feed')}
					class="-mb-px border-b-2 px-2 py-2 text-sm transition-colors {tab === 'feed'
						? 'border-accent font-medium text-content'
						: 'border-transparent text-content-muted hover:text-content'}"
				>
					Feed
				</button>
				<button
					type="button"
					role="tab"
					id="tab-board"
					data-testid="tab-board"
					aria-selected={tab === 'board'}
					aria-controls="panel-board"
					onclick={() => show('board')}
					class="-mb-px flex items-center gap-1.5 border-b-2 px-2 py-2 text-sm transition-colors {tab ===
					'board'
						? 'border-accent font-medium text-content'
						: 'border-transparent text-content-muted hover:text-content'}"
				>
					Board
					{#if openTasks > 0}
						<span
							data-testid="tab-board-count"
							class="rounded-full bg-surface-raised px-1.5 text-xs text-content-muted tabular-nums"
						>
							{openTasks}
						</span>
					{/if}
				</button>
			</div>

			{#if tab === 'feed'}
				<!--
					`min-w-0` is load-bearing, not tidiness. A grid item defaults to
					`min-width: auto`, so it refuses to shrink below its content's
					intrinsic width — one wide update dragged a 375px phone's layout
					viewport out to 723px, and the browser zoomed the whole dashboard out
					to compensate (design §7).
				-->
				<!--
					Labelled by its own words rather than by the tab: `aria-labelledby`
					would win over `aria-label`, and "Update timeline" is what every
					other part of this app calls this region.
				-->
				<div
					role="tabpanel"
					id="panel-feed"
					class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]"
					aria-label="Update timeline"
				>
					<!--
						Above the scroller rather than inside it, so it is still there when
						the owner is halfway down a long day. Aligned to the same column as
						the cards, or it would read as belonging to the chrome rather than
						to the feed.
					-->
					<div class="mx-auto w-full max-w-3xl px-3 pt-4 sm:px-4">
						<Composer {project} projects={feed.projects} {actions} />
					</div>

					<TimelineView
						{feed}
						{taskTitles}
						requests={feedRequests}
						{projectNames}
						agentNames={posters}
						{media}
						{actions}
						{threads}
						{onlineIds}
						{focus}
						{threadRequests}
					/>
				</div>
			{:else}
				<div
					role="tabpanel"
					id="panel-board"
					aria-labelledby="tab-board"
					class="flex min-h-0 min-w-0 flex-col px-3 py-4 sm:px-4"
				>
					<Board
						tasks={tasks.items}
						board={boardColumns}
						agentNames={posters}
						selected={feed.task}
						onselect={(taskId) => {
							void feed.filterByTask(taskId);
							// Back to the feed, because filtering it is what the click did and
							// a filter applied to a view nobody is looking at is a click that
							// appeared to do nothing.
							show('feed');
						}}
					/>
				</div>
			{/if}
		</main>

		<aside class="hidden min-h-0 overflow-y-auto border-l border-border-subtle xl:block">
			<RightRail {presence} {actions} />
			<div class="border-t border-border-subtle p-3">
				<TasksPanel
					{tasks}
					{project}
					projects={feed.projects}
					agentNames={posters}
					{onlineIds}
					{actions}
					{threads}
				/>
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
			<RightRail {presence} {actions} />
			<div class="border-t border-border-subtle p-3">
				<TasksPanel
					{tasks}
					{project}
					projects={feed.projects}
					agentNames={posters}
					{onlineIds}
					{actions}
					{threads}
				/>
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
				{requestCounts}
				totalRequests={requests.items.length}
				{unseenCounts}
				{openTasks}
				{projectImages}
				onnavigate={() => (drawer = false)}
				{actions}
			/>
		</div>
	</div>
{/if}
