<script lang="ts">
	/**
	 * The task board, as its own tab (design §7).
	 *
	 * The dashboard answers two questions and they are not the same shape. The
	 * feed is "what happened": newest first, read and forgotten. The board is
	 * "what is being worked on": a small set of things that outlive any one
	 * update, and which the owner scans rather than reads. Those are two ways of
	 * looking at one project rather than two halves of one screen, so they are two
	 * tabs — and the board gets the whole column, which is what a board needs and
	 * what a strip wedged above a busy feed never had.
	 *
	 * **Columns are a view over task states, not a second vocabulary.** A state is
	 * what an agent wrote: `claim_task` writes `claimed`, `complete_task` writes
	 * `done`, and the whole fleet depends on those words. A column is how the
	 * owner wants to look at them, so renaming or merging columns costs agents
	 * nothing — and a column agents could not write to would be a lane nothing
	 * ever enters. Which is why the editor offers states to gather rather than a
	 * free-text lane name that means nothing to anybody but the owner.
	 *
	 * Unlike the strip this replaced, an empty board renders its lanes rather than
	 * nothing: the owner asked for this view by clicking a tab, and a tab that
	 * turned out blank would read as broken rather than as "no tasks yet".
	 */
	import { agentLabel } from './avatar';
	import { absoluteLabel, relativeLabel } from './days';
	import type { BoardColumn, ProjectBoard, TaskView } from './types';

	let {
		tasks = [],
		/** The project's own columns, or `null` for the default three. */
		board = null,
		agentNames = {},
		/**
		 * The task the feed is filtered to, if any (design §7).
		 *
		 * Clicking a task filters the feed rather than navigating: the board and the
		 * feed are two views of the same work, and a separate page per task would
		 * take the board away to show what is under one card of it. The shell
		 * switches back to the feed tab, because a filter nobody can see applied is
		 * a click that did nothing.
		 */
		selected = null,
		onselect
	}: {
		tasks?: TaskView[];
		board?: ProjectBoard | null;
		agentNames?: Record<string, string>;
		selected?: string | null;
		onselect?: (taskId: string | null) => void;
	} = $props();

	/**
	 * The default board (design §7).
	 *
	 * Three columns, because that is the shape of the work: waiting, being done,
	 * over. `cancelled` is deliberately absent — a cancelled task is not a lane
	 * somebody works through, and a column for it would be a standing reminder of
	 * everything ever called off. A project that wants one can add it.
	 */
	const DEFAULT_COLUMNS: BoardColumn[] = [
		{ title: 'To do', states: ['todo'] },
		{ title: 'In progress', states: ['claimed'] },
		{ title: 'Done', states: ['done'] }
	];

	const columns = $derived(board?.columns ?? DEFAULT_COLUMNS);
	const lanes = $derived(
		columns.map((column) => ({
			...column,
			items: tasks.filter((task) => column.states.includes(task.state))
		}))
	);
	/** Whether anything is on the board at all, for the one line that says so. */
	const populated = $derived(lanes.some((lane) => lane.items.length > 0));

	const who = (agentId: string | null) =>
		agentId ? agentLabel(agentId, agentNames[agentId]) : null;

	/** When a task last moved, which is more use than when it was created. */
	const movedAt = (task: TaskView) => task.doneAt ?? task.claimedAt ?? task.createdAt;
</script>

<section
	class="flex h-full min-h-0 flex-col gap-3"
	aria-labelledby="board-heading"
	data-testid="board"
>
	<!--
		The tab above already says "Board", so the heading is here for the
		accessible tree rather than as a second copy of the word on screen.
	-->
	<h2 id="board-heading" class="sr-only">Board</h2>

	{#if !populated}
		<p class="text-sm text-content-muted" data-testid="board-empty">
			No tasks yet. Agents create them over MCP and they appear here as they move.
		</p>
	{/if}

	<!--
		Scrolls sideways rather than wrapping: a board is read across, and columns
		that reflowed onto a second row would stop being lanes. The overflow is on
		this element so the page itself never scrolls sideways, and each lane
		scrolls down inside itself so the column headings stay put.
	-->
	<div
		class="-mx-1 flex min-h-0 flex-1 gap-3 overflow-x-auto px-1 pb-1"
		data-testid="board-columns"
	>
		{#each lanes as lane (lane.title)}
			<div class="flex min-h-0 w-64 shrink-0 flex-col gap-2" data-testid="board-column">
				<div class="flex items-baseline gap-1.5">
					<span data-testid="board-column-title" class="truncate text-xs font-medium text-content">
						{lane.title}
					</span>
					<span class="text-xs text-content-muted tabular-nums">{lane.items.length}</span>
				</div>

				<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
					{#each lane.items as task (task.id)}
						<!--
							A toggle, not a link. Clicking again clears the filter, which is
							what the second click on a thing that is already selected means
							everywhere else.
						-->
						<button
							type="button"
							data-testid="board-task"
							data-state={task.state}
							aria-pressed={selected === task.id}
							onclick={() => onselect?.(selected === task.id ? null : task.id)}
							class="flex shrink-0 flex-col gap-1 rounded-lg border border-border-subtle bg-surface-raised p-2 text-left hover:border-content-muted aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-accent"
						>
							<span style="overflow-wrap:anywhere" class="text-sm text-content">
								{task.title}
							</span>
							<span class="flex items-center gap-2 text-[0.65rem] text-content-muted">
								{#if who(task.agentId)}
									<span class="truncate">{who(task.agentId)}</span>
								{/if}
								<time
									class="ml-auto shrink-0"
									datetime={new Date(movedAt(task)).toISOString()}
									title={absoluteLabel(movedAt(task))}
								>
									{relativeLabel(movedAt(task))}
								</time>
							</span>
						</button>
					{/each}

					{#if lane.items.length === 0}
						<p
							class="rounded border border-dashed border-border-subtle p-2 text-xs text-content-muted"
						>
							Nothing here.
						</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</section>
